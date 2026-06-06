# Proposal: Live Measurement + Processing Flow

**Date:** 2026-05-22
**Status:** Proposed (DESIGN ROUND — no agreement to build yet; user reviews this doc + answers OQ1..OQ12 before any Wave 1 dispatch).
**Author tag:** `[live-processing-design]`.

> **Implementation note (2026-06-06):** Wave-1 PLUMBING already LANDED but is INERT/unwired — do NOT re-implement it. `LiveProcessingOrchestrator` (`live_processing_orchestrator.py`) + `live_processing_subprocess.py` + the ProjectContext live-processing fields/locks + the CuPy-recording-thread probe gate shipped via PianoidCore `79510db` (`feature/dev-liveproc-w1`). However `LiveProcessingOrchestrator` is constructed ONLY in tests — it is NOT wired into any production path (the `collection_engine.py` / `project_context.py` references are comments; no `MeasurementSession.on_scenario_done` → `handle_scenario_done` callback is registered). The functional flow (Wave 2: `handle_scenario_done` actually running ESPRIT+tracking, the 3 REST endpoints, `useLiveProcessing.js`, the UI) and Wave 3 (cancel/pause/error) are un-built. Still gated on OQ1-12 + MODULE_LOCKS coordination with modal-adapter-split Wave 3 (in progress).
**Scope:**
- PianoidCore: `pianoid_middleware/modal_adapter/collection_engine.py`, `esprit_orchestrator.py`, `tracking_orchestrator.py`, `apply_service.py`, `project_context.py`, `measurement_routes.py`, `modal_adapter.py` (facade).
- PianoidTunner: `modules/panels/CollectionSubpanel.jsx`, `modules/panels/ProjectSubpanel.jsx`, `modules/ModalAdapter.jsx`, `hooks/useModalAdapter.js`, `hooks/modalAdapter/useProjectCRUD.js`, `hooks/useMeasurementCatalog.js`, plus a new `useLiveProcessing` hook.

**Related docs:**
- [`docs/proposals/modal-adapter-split-2026-05-21.md`](modal-adapter-split-2026-05-21.md) — Wave 2 just shipped (`EspritOrchestrator`, `TrackingOrchestrator`, `ApplyService`). This proposal builds on those orchestrators; Wave 3 (`ProjectStore`, `ChainEditor`, facade rewrite) is still pending. **Sequencing question OQ12** below.
- [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](modal-adapter-measurement-entity-2026-05-10.md) §5 — the N5 "snapshot frozen at create time" contract, and §3.4 — the v2 collect REST surface (`POST /modal/measurements/<id>/collect/start` etc.).
- [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../modules/pianoid-middleware/MODAL_COLLECTION.md) — current `MeasurementSession` lifecycle (single-active-session, pause/resume coordination, Q8 streaming-messages ring buffer).
- [`docs/architecture/SYSTEM_OVERVIEW.md`](../architecture/SYSTEM_OVERVIEW.md) — 4-layer stack, port 5000 vs 5001 separation (CuPy-on-main-thread requirement), launcher `ws` broadcast surface.
- [`PianoidTunner/src/hooks/useSoundChannels.js`](../../PianoidTunner/src/hooks/useSoundChannels.js) — canonical reference implementation of the three frontend-state principles (single-source-of-truth, granular writes, no speculative emits).

---

## 0. Problem Statement

Today the user has two **sequential** workflows:

1. **Collection** — open a Measurement (Collection subpanel), record scenarios one by one (`POST /modal/measurements/<id>/collect/start` × N), each scenario writes
   `<measurement>/scenarios/<scenario_name>/averaged_responses/average_chN.npy` and a flat
   `measurements/scenario_N.npy` mirror.
2. **Processing** — once Collection is "finished", create a Project from the Measurement
   (`create_project_from_measurement`), the create call runs the canonical averager, snapshots
   the Measurement's `setup/*` into `project.json.measurement_snapshot`, then the user opens
   the Project, runs ESPRIT (`POST /modal/run_esprit`) per-scenario, then runs Tracking
   (`POST /modal/run_tracking`), then sees results.

The two workflows touch **disjoint state surfaces** today:
- Collection mutates `<measurement>/scenarios/` via `MeasurementSession` on Modal Adapter (port 5001).
- Processing mutates `ProjectContext` (`per_scenario_results`, `tracked_chains`, …) via the
  ESPRIT + Tracking + Apply orchestrators on the same Modal Adapter.

But they are **coupled in time by the user**: each scenario is recorded, the user waits, then
later — minutes, hours, or the next day — feeds the whole batch into ESPRIT and Tracking.
The feedback loop is open: a bad scenario (mic glitch, wrong layout, bad excitation hit)
isn't surfaced until the post-recording analysis pass.

### What the user asked for

> "Next task: plan and implement measurement + processing flow. Requires both measurement set
> and esprit project to be open. Each newly collected measurement is immediately processed by
> esprit (in parallel thread, not blocking the collection) and tracking rerun to incorporate
> new data."

Restated as a system-level requirement:

> The user has BOTH a Measurement AND a Project open at the same time. Every newly recorded
> scenario is fed into the Project's ESPRIT pipeline in a background thread (does NOT block
> the next recording). Tracking re-runs incrementally to fold the new modes into existing
> chains. The user sees the stab diagram + chain list update as they record.

The value proposition is tightening the user's feedback loop: instead of "record 30 scenarios →
analyse them all together → discover the layout is wrong → re-record all 30", the user sees
the modes appear chain by chain as they record. A bad scenario is visible immediately.

---

## 1. Current State Inventory

### 1.1 Collection lifecycle (today)

```
Frontend                            Modal Adapter (port 5001)            Backend (port 5000)
  CollectionSubpanel
        |
        | POST /modal/measurements/<id>/collect/start
        |   { scenario_number, description, computer, room,
        |     recorder_config_overrides }
        v
  measurement_routes.start_collect
        |
        | MeasurementSession.start(scenario_number=..., project_dir=<measurement>/scenarios,
        |                          measurement_id=...)
        |   - daemon Thread spawned
        |   - phases: pausing -> recording -> saving -> resuming -> done
        |
        |   _pause_backend()                                              POST /pause_synthesis
        |                                                                 (releases SDL3 device)
        |   ... RoomResponseRecorder.take_record(...) ...
        |   ... averager(scenario_dir) ...                                  (returns 200)
        |   _resume_backend()                                              POST /resume_synthesis
        |
        | <-- session_id (returned immediately, polling-based progress)
        |
        | GET /modal/measurements/<id>/collect/status (polled by FE)
        |   { phase, progress_pct, messages, scenario_subdir }
```

**Key facts:**
- `MeasurementSession` is a **singleton** per Modal Adapter process (single-active-session
  constraint — the audio device is exclusive).
- Per-session state lives in `_SessionState` dataclass (phase, progress, messages ring buffer,
  output_paths, measurement_id).
- Completed sessions go into `_history: Dict[session_id, _SessionState]` (bounded to last 16).
- Streaming progress is **polled** today — frontend GETs `/collect/status` every ~1s. There
  is a `messages` ring buffer (cap 100) but no push mechanism — the launcher has a
  WebSocket but it's used only for backend-process status/log fan-out, not for modal-adapter
  events.

### 1.2 ESPRIT processing lifecycle (today, post-Wave-2)

```
Frontend (per-scenario loop)        Modal Adapter
  ProjectSubpanel / Setup section
        |
        | (per scenario) POST /modal/run_esprit { bands, scenario_indices: [N] }
        v
  pipeline_routes.run_esprit  ->  adapter.run_esprit(esprit_params, scenario_indices)
        |                              -> EspritOrchestrator.run_esprit (Wave 2)
        |                                   -> _run_esprit_sync (RUNS SYNCHRONOUSLY ON MAIN THREAD)
        |                                       - CuPy GPU deadlocks in threads -> runs sync
        |                                       - EspritRunner.run_all_points(...) -> mode data
        |                                       - ctx.per_scenario_results.update({N: ...})
        |                                       - _persist_esprit_results -> esprit/scenario_N.json
        |                                   -> returns {state, message}
        |
        | <-- {state: "done", message: "Complete"}
```

**Key facts:**
- `_run_esprit_sync` runs **synchronously on the main thread** because CuPy GPU operations
  deadlock in non-main threads (this is why the Modal Adapter server runs with `threaded=False`).
  The "background thread" comment in `run_esprit` is historical — `self._run_thread = None`
  and the body is `self._run_esprit_sync(...)` inline.
- Cancellation is via `self._cancel_event: threading.Event` checked inside the EspritRunner
  loop.
- Per-scenario results merge into `ctx.per_scenario_results` (a `Dict[int, Dict]`).
- The current frontend drives the per-scenario loop — issues one POST per scenario in series.

### 1.3 Tracking lifecycle (today, post-Wave-2)

```
Frontend (after ESPRIT)             Modal Adapter
  ProjectSubpanel / Tracking
        |
        | POST /modal/run_tracking { bridge_boundary, freq_tol_pct, max_gap,
        |                            tracking_method, tracking_options }
        v
  pipeline_routes.run_tracking -> adapter.run_tracking(...)
        |                            -> TrackingOrchestrator.run_tracking
        |                                 -> EspritRunner.run_tracking(per_scenario,...)
        |                                     - returns all_chains (List[ModeChain])
        |                                 -> ctx.tracked_chains = chains_to_dicts(all_chains)
        |                                 -> ctx.tracked_chains_raw = all_chains
        |                                 -> ctx.cross_bridge_matches, ctx.splitter_reports
        |                                 -> ctx.nuclei_stage_chains[_raw]
        |                                 -> _persist_cb("tracking", "chains.json", ...)
        |                                 -> ctx.chain_undo_stack.clear()
        |                                 -> ctx.chain_redo_stack.clear()
        |                                 -> ctx.tracked_chains_version += 1     <-- THE VERSION BUMP
        |
        | <-- { chains, summary, cross_bridge_matches, splitter_reports, ... }
```

**Key facts:**
- Tracking runs **synchronously** (no thread). Takes per-scenario ESPRIT results from
  `ctx.per_scenario_results` and produces chains.
- **Tracking re-runs from scratch every time.** It rebuilds the chain set from the entire
  `per_scenario_results` dict — there is no incremental "fold in scenario N" path.
- `ctx.tracked_chains_version` is bumped on every run; the frontend's `useModalAdapter`
  watches `data_status.tracked_chains_version` and re-fetches chains/heatmap when it changes.

### 1.4 The "Project is open" model

Today there is exactly ONE Project loaded into the Modal Adapter at a time. `ProjectContext`
is a process-singleton (`ModalAdapter.__init__` creates ONE `self._ctx`). Opening a different
Project calls `reset()` which clears every ctx field, then loads the new project.

`project.json.measurement_snapshot` is a **frozen deep-copy** of the parent Measurement's
`setup/*` at create time (N5 — see [measurement-entity §5](modal-adapter-measurement-entity-2026-05-10.md)).
The snapshot exists so the Project's analysis is reproducible against the setup the
Measurement had on that day. The snapshot is NEVER updated after Project creation.

**But** — the Project also holds:
- A **measurement_id pointer** (`project.json.measurement_id`) and **measurement_path** to the
  parent Measurement's root.
- Its own `per_scenario_results` set, keyed by scenario index, loaded from the parent
  Measurement's `scenarios/` directory (via `_load_v2_scenarios_from_parent_measurement`
  during `open_project`).

So the Project ALREADY consumes data from a live Measurement — it just does so at open time,
not continuously. The "frozen snapshot" is only the **setup configuration** (mapping, channel
roles, audio device, impulse params, etc.) — not the scenario data itself.

**This is the architectural break we need.** A Project today is "frozen against this
Measurement state at this moment". The new model is "Project tracks the live Measurement and
re-processes as scenarios appear". The frozen-setup contract (N5) can stay intact — the
new behaviour is only about scenario data, not setup.

### 1.5 Can a Measurement and a Project be loaded simultaneously today?

**Yes — both are independently selectable in the frontend.** `CollectionSubpanel` owns
its own `selectedMeasurementId` state (or accepts a controlled prop from the parent). The
Modal Adapter section toggle (`activeSection`) controls which subpanel is rendered, but the
backend doesn't enforce a "Measurement xor Project" exclusivity — `MeasurementSession` and
`ProjectContext` are independent globals on the Modal Adapter process.

What's NOT today:
- The frontend does not link "this Project's parent Measurement is now collecting; live-process its new scenario."
- The backend has no notification mechanism from `MeasurementSession` to `EspritOrchestrator`.
- The frontend's Collection subpanel and Project subpanel do not share a "live processing is
  on" state machine.

So the data-model invariants don't block simultaneous live-processing — only the wiring is
missing.

### 1.6 Frontend update mechanisms today

| Mechanism | Use today | Suitability for live-processing |
|---|---|---|
| **REST polling** | `useMeasurementCollection*` polls `/collect/status` every ~1s | Already in use for collection. Cheap to extend for "new scenario processed". |
| **`tracked_chains_version` bump** | `useModalAdapter` watches this in `data_status`; re-fetches chains/heatmap on bump (round-21 chart-remount-on-version-bump pattern) | Exactly the pattern we need for "modes changed". Already wired. |
| **`presetVersion` bump in `usePreset`** | Triggers editor-hook re-init on `/load_preset`/`/preset/switch` (Phase C2 principle 1) | Backend-state coupling pattern; we could mirror this for "project re-tracked". |
| **Launcher WebSocket (`ws`)** | Launcher → frontend, used only for backend/modal process status + stderr fan-out (`broadcast({type:'status',...})`, `broadcast({type:'log',...})`) | Could be extended, but it's a **launcher-side** socket — neither port 5000 nor port 5001 push events through it. Adding modal-side events means routing through the launcher, which is awkward. |

There is **no Socket.IO or SSE** on Modal Adapter. Adding one is possible (Flask-SocketIO is
already a backend (port 5000) dependency for chart pushes), but for the current data volumes —
~1 per-scenario completion every ~5-30 seconds, ~1 tracking-rerun completion at the same
cadence — polling is sufficient and avoids a new dependency on port 5001. See decision **Q5**
below.

---

## 2. Why Integrate

| User value | Today | After |
|---|---|---|
| **Faster feedback on a bad scenario** | User records 30, runs ESPRIT later, sees "scenario 7 produced no modes" 20 minutes later. Re-records 30. | After scenario 7 completes, modes show up (or don't); user fixes setup and re-records scenario 7 in 1 minute. |
| **Real-time mode tracking** | Stab diagram empty until full batch is processed | Chain list grows as the user records. They can stop early if they're satisfied. |
| **Smaller per-scenario verification loop** | "Done? Run analysis. Wait. Inspect." | Each scenario is its own micro-experiment with visible results. |
| **Continuous QC** | Effective-signal-length QC only at create_project_from_measurement | Could fold per-scenario QC into the live pipeline (deferred — see §10 risk #5) |

The integration costs are bounded — the orchestrators already exist (Wave 2 shipped 2026-05-17),
the version-bump pattern already exists, the per-scenario REST endpoint already exists. The
new work is:
1. **A `LiveProcessingOrchestrator`** that wires `MeasurementSession` completions into
   `EspritOrchestrator.run_esprit(scenario_indices=[N])` + `TrackingOrchestrator.run_tracking()`,
   running on a background-thread executor sized to one worker (single-active analysis run).
2. **A linkage** in `ProjectContext` recording which Measurement-id the open Project is
   "live-tracking". When `MeasurementSession.measurement_id` matches, completions trigger
   processing.
3. **Frontend wiring** to surface the new state machine (live-processing on/off, last
   processed scenario, processing-in-flight indicator) and to react to the version bumps.

---

## 3. The Twelve Architectural Decisions

Following the modal-adapter-split-2026-05-21 §2 precedent — surface the decisions explicitly,
get them locked by the user, then implement against the locked set. Defaults shown are the
proposal author's recommendation; user can override each.

### Q1: Threading model for live processing

**The constraint:** CuPy deadlocks in non-main threads, which is why the current `_run_esprit_sync`
runs on the main thread and the Modal Adapter Flask server runs with `threaded=False`. So
"in a parallel thread, not blocking collection" doesn't mean "in a Python thread that runs
ESPRIT" — it means "not blocking the **recording thread**", which is already a different
thread (`MeasurementSession`'s daemon worker).

**Three candidate models:**

| Model | How | Cost | Verdict |
|---|---|---|---|
| **A. Main-thread queue, processed between recordings** | Recording thread emits "scenario N done" event onto a queue; Modal Adapter Flask main thread drains the queue when idle (between REST requests). | Zero new threads. But: blocks REST requests during ESPRIT. Worst case ESPRIT runs while user clicks "Cancel" — REST request waits. | **Reject** — blocks the only Flask worker; no parallelism. |
| **B. Single dedicated background worker thread** | One persistent `threading.Thread` runs a `queue.Queue` consumer loop. Each enqueued `(measurement_id, scenario_idx)` triggers ESPRIT+tracking. **Risk: CuPy deadlock.** | One new thread. CuPy must work in this thread — same constraint that today forces sync execution. | **Reject** — same CuPy deadlock that blocks today's threaded mode. |
| **C. Subprocess worker (separate Python process)** | A child Python process subscribes to a queue (multiprocessing.Queue or filesystem-watched dir or HTTP push). Runs ESPRIT in its own process with its own CUDA context. | Heaviest infrastructure. New process lifecycle. But: real parallelism with CuPy. | **Reject** — too much for the value; CUDA context per process; large IPC surface. |
| **D. Same-process, **same-thread**, processed via a "ready queue" the recording thread drains BEFORE returning** | Recording thread, after `_finalize_outputs` succeeds, BEFORE returning, calls a "process this scenario" hook synchronously. Hook calls `EspritOrchestrator.run_esprit(scenario_indices=[N])` on the recording thread. **CuPy works because there's no Flask request in flight.** Recording thread blocks on ESPRIT for ~5-30s; the audio device is already released. | Zero new threads. Recording thread runs ESPRIT after recording. | **The recommended path.** See expansion below. |

**Recommended: D — process-on-recording-thread.**

**Why D works:**
- The recording thread (`MeasurementSession._run`) is NOT the Flask main thread. After
  `_resume_backend()`, the recording phase is over; the audio device is back with Pianoid. The
  thread is just "post-processing the scenario it just recorded" before terminating.
- The collection thread is **already blocking** the next recording — `MeasurementSession`
  is single-active-session, so the user can't `POST /collect/start` for scenario N+1 until
  scenario N's thread finishes anyway.
- The Flask main thread is FREE during the ESPRIT processing — REST requests still work.
  This is critical: the user can poll `/collect/status` and see "phase: processing" while
  the recording thread runs ESPRIT.
- **CuPy concern:** the recording thread is a daemon Python thread, not the main thread.
  If CuPy deadlocks here, we have a problem. **Mitigation: measure-first.** The CuPy
  deadlock is documented for **Flask request handler threads** specifically. The recording
  thread is a different thread family — it might work. Wave 1 starts with a CuPy probe
  test on the recording thread; if it deadlocks, we fall back to **Model E**:

| Model | How | Cost | Verdict |
|---|---|---|---|
| **E. Queue + serialize-via-Flask-main** | Recording thread enqueues completion; the next Flask request that lands on the main thread drains one item. This is "model A but pull-based instead of push-based". | The user already polls `/collect/status` every 1s — that polling thread becomes the drain. | Fallback if D's CuPy probe fails. |

**Decision:**
- **Q1 default: model D** (process on recording thread). With a Wave-1 CuPy probe gate — if
  the probe deadlocks, switch to model E before any user-visible feature lands.

### Q2: Concurrency safety / lock strategy

`ProjectContext` was designed (split proposal §5.4) as single-threaded except for the cross-thread
fields owned by `EspritOrchestrator` (cancel event + progress lock). With live processing,
the picture changes:

**New concurrent accesses:**

| Reader | Writer | Conflict shape |
|---|---|---|
| Flask request handler (GET /modal/results) | Recording thread mutating `ctx.per_scenario_results.update({N: ...})` | Dict mutation during iteration; GIL makes single-key writes atomic but bulk reads can interleave |
| Flask request handler (GET /modal/tracking_results) | Recording thread replacing `ctx.tracked_chains` after tracking re-run | List replacement; GIL atomic for the rebind, but reader could see pre-rebind state then act on post-rebind version |
| Frontend (polling `data_status.tracked_chains_version`) | Recording thread incrementing `ctx.tracked_chains_version += 1` | Int increment is NOT atomic in CPython (load + add + store); risk of lost bump |
| `ChainEditor` undo/redo (future Wave 3 of split proposal) | Recording thread mutating `tracked_chains` via re-tracking | Editor's undo snapshot may capture a live-replaced chain list |

**Three lock strategies:**

| Strategy | Mechanism | Cost |
|---|---|---|
| **A. Single coarse `ctx_lock = threading.RLock()`** | Every read/write of `ctx.per_scenario_results`, `ctx.tracked_chains`, `ctx.tracked_chains_version`, etc. takes the lock. | Easiest to reason about. Penalises every Flask request (~10-100µs). Risk of contention during a chain re-fetch happening mid-recording. |
| **B. Per-field locks** | Separate locks for `per_scenario_results`, `tracked_chains`, version counter. | Fine-grained but easy to miss a callsite. Lock-ordering risk. |
| **C. Snapshot-on-read** | Writer rebinds (`ctx.tracked_chains = [...new list...]`); readers grab a reference and iterate. No locks needed for already-atomic operations (rebind, int increment under GIL). | Cheapest. Works if writes are always full replacements + reads are reference-grabs. Doesn't work for incremental dict.update(). |

**Recommended: hybrid B + C.**
- `per_scenario_results` — wrap in a dedicated `_per_scenario_lock = threading.Lock()` since
  writes are dict.update() (incremental, not replacement). Lock acquired during
  `update()` and during any callsite that iterates the whole dict (GET /results, tracking input
  collection).
- `tracked_chains`, `nuclei_stage_chains`, `cross_bridge_matches`, `splitter_reports` —
  always full-replaced by `TrackingOrchestrator.run_tracking`. Writer rebinds; readers grab
  reference. No lock needed.
- `tracked_chains_version` — **explicit `threading.Lock` around increment**. The two-step
  read-then-bump that the frontend version-watcher relies on must be atomic.
- `run_state`, `progress` — already locked by `EspritOrchestrator`'s internal state model;
  unchanged.

The lock additions go on `ProjectContext` (one new lock attribute), the locked accessors get
helper methods on the dataclass (`with_per_scenario_results(self) -> ContextManager[Dict]`,
`bump_tracked_chains_version(self) -> int`). Callers use the helpers; raw `ctx.per_scenario_results.update()` becomes a code-smell flagged by review.

### Q3: Trigger mechanism

**The event:** "scenario N for measurement M just finished recording AND the Project that
is open is linked to measurement M".

**Three trigger candidates:**

| Mechanism | How |
|---|---|
| **A. In-process callback registered on `MeasurementSession`** | `MeasurementSession.__init__(..., on_scenario_done: Optional[Callable[[str, int, str], None]] = None)`. The Modal Adapter's `ModalAdapter` facade wires this at construction time to point at `LiveProcessingOrchestrator.handle_scenario_done(measurement_id, scenario_number, scenario_subdir)`. Called from `_run()` after `_finalize_outputs` succeeds, before `_set_phase("resuming")`. |
| **B. Filesystem watcher** | Watch `<measurement>/scenarios/` for new `averaged_responses/` directories. Trigger via file-system event. |
| **C. REST callback from frontend** | After the frontend sees `phase: done` on the status poll, it POSTs `/modal/projects/live_process/<scenario_number>` to the Modal Adapter. |

**Recommended: A — in-process callback.**

- Cleanest: same process, no FS race, no FE round-trip latency.
- Wire-up cost: `MeasurementSession` already has `_recorder_factory`/`_collector_factory`
  injection points; an `on_scenario_done` callback follows the same DI pattern.
- The callback signature is `(measurement_id: str, scenario_number: int, scenario_subdir: str) -> None`.
  It's invoked from the recording thread; it's responsible for noticing "is the open Project
  linked to this measurement_id?" and either kicking off processing (in model D from Q1, on
  this same thread) or enqueueing a job (model E).
- B is rejected because FS events are coarse on Windows + introduce a watcher thread + race
  with `_finalize_outputs` ordering.
- C is rejected because it makes the frontend authoritative for an in-process backend event;
  network failures break the loop silently.

### Q4: Tracking re-run cadence

**Per-scenario** is the user's stated preference ("tracking rerun to incorporate new data").
But tracking re-runs from scratch over the whole `per_scenario_results` dict (§1.3); on
30 scenarios this is ~1-3s typically. Running it per-scenario means every recording adds 1-3s
to the "live-processing" tail.

**Three cadence options:**

| Cadence | Pros | Cons |
|---|---|---|
| **A. Per-scenario** | Simplest. User sees chains update after every recording. Maximum information density. | 1-3s extra per recording. If user records back-to-back fast, queue piles up. |
| **B. Debounced (e.g. 5s idle after last scenario, OR every 5th scenario, whichever first)** | Cheaper. Batches re-tracks during rapid recording. | User sees chains update in chunks, not continuously. More state to manage (debounce timer thread). |
| **C. Per-scenario with debounce-merge** | If a new scenario arrives WHILE tracking is running, queue ONE rerun; merge multiple-scenarios-during-track into one followup. | More complex but no user-visible delay. |

**Recommended: A initially, plan for C if user reports rapid-recording friction.**

- Initial implementation: per-scenario. User's directive is explicit.
- The recording thread runs ESPRIT (scenario N only, scoped via `scenario_indices=[N]`), then
  runs tracking on the full `per_scenario_results` dict, then returns. Total tail: ~10s/scenario
  for ESPRIT + 1-3s for tracking = ~13s post-recording.
- If users record faster than this (every ~10s), back-pressure: the second `/collect/start`
  call returns 409 (the recording thread isn't done; single-active-session rule still holds).
  This is user-visible feedback that processing is the bottleneck. They can disable
  live-processing if it hurts their flow.
- Upgrade path to C is a small refactor — add a "is tracking currently running" lock and
  a "pending rerun?" boolean. Don't build this in Wave 1.

### Q5: Frontend update push mechanism

**Already discussed in §1.6.** Three options:

| Option | Suitability for this feature |
|---|---|
| **A. REST polling (existing pattern)** | The Collection subpanel already polls `/collect/status` every ~1s. Extend the status payload to include `live_processing: {state: "idle"|"processing"|"tracking", last_scenario_processed: N, tracked_chains_version: V}`. Frontend already has the version-watcher pattern for tracking. |
| **B. Add Flask-SocketIO to port 5001** | Real-time push. New dependency on Modal Adapter. CuPy + eventlet have known incompatibilities. |
| **C. Server-Sent Events (SSE)** | Lighter than SocketIO, supported by Flask natively. New endpoint `/modal/measurements/<id>/events` that streams JSON-encoded events. |

**Recommended: A.** The existing polling cadence (1s) is fine for the data volumes here (one
event every ~10-30s when actively recording). Polling is already proven in this codebase
(`tracked_chains_version` watcher in `useModalAdapter`). Adding SocketIO/SSE to Modal Adapter
is a meaningful infrastructure change for a feature that doesn't need millisecond latency.

If a future feature (e.g. per-cycle waveform streaming) needs <100ms latency, SSE is the
cheap upgrade.

### Q6: Project lifecycle — single Project, or live-Project + final-Project?

**The dilemma:**
- The N5 contract says `project.json.measurement_snapshot` is frozen at create time. If the
  user opens a Project + records 20 more scenarios, the Project's snapshot doesn't know about
  the new scenarios' setup (if setup changed). The snapshot was the OLD setup.
- But scenario data isn't covered by the snapshot — it's stored in
  `<measurement>/scenarios/` and read by the Project's `_load_v2_scenarios_from_parent_measurement`.
- So actually the live-processing flow IS compatible with N5 — the snapshot is the **setup**,
  not the **scenario data**. The Project gets new scenarios from the Measurement on the fly.

**Two model options:**

| Model | Behaviour |
|---|---|
| **A. Single Project, lives forever, accumulates new scenarios live** | The Project the user opens IS the project that gets results from live-processing. Final `apply_to_preset` uses this Project. The snapshot in `project.json.measurement_snapshot` stays frozen at create time. |
| **B. "Live preview" Project + finalized Project** | The user opens a temporary "live preview" Project. When they finish recording, they "finalize" — which creates a fresh Project via `create_project_from_measurement` (re-runs the averager, takes a fresh snapshot, processes the whole batch). The live preview is discarded. |

**Recommended: A.** Simpler, matches the user's mental model ("I'm working in this Project
and it gets new scenarios as I record"). The N5 frozen-snapshot is unaffected — it captures
setup at create time, and setup shouldn't change during a recording session (if it does, the
new scenarios will have inconsistent setup metadata, and that's a different problem).

One concern: when the live-processing Project is opened, the user may already have run
ESPRIT/tracking on a subset of scenarios. New scenarios append to that result set. Tracking
re-runs over the union. **There is no "incremental tracking that knows what was there before"
mode** — tracking always rebuilds from `per_scenario_results`. This is fine; the cost is the
1-3s per re-run.

### Q7: Cancellation / pause semantics

**State machine to define:**

```
LiveProcessing state (ProjectContext.live_processing_state):

  off
    | user clicks "Enable live processing" + Project's measurement_id matches
    | open Measurement's id
    v
  enabled, idle
    | scenario N completes recording
    v
  enabled, esprit_running (scenario_idx = N)
    | esprit completes
    v
  enabled, tracking_running
    | tracking completes
    v
  enabled, idle    (back to top)
```

**User actions:**

| Action | Effect |
|---|---|
| User closes the Project (opens a different one) | Live-processing state → off. Ongoing ESPRIT for the previous Project: keep running to completion (writes to ex-Project's disk), but don't bump any new-Project version. Tracking, similarly. |
| User opens a different Measurement in Collection subpanel | Live-processing state stays attached to the original Measurement-Project pair. The new Measurement is independent. (User can switch back later and resume live processing.) |
| User clicks "Pause live processing" | New scenarios still get recorded. They are NOT processed automatically. When user re-enables, the **queue of unprocessed scenarios** is drained on the next scenario completion (catch-up mode). |
| User clicks "Pause recording" (cancels scenario N+1) | Doesn't affect any in-flight processing for scenario N. |
| User cancels mid-ESPRIT (e.g. via existing `/modal/cancel`) | `cancel_event` set → EspritRunner respects it → ESPRIT returns partial. `live_processing_state` → `enabled, idle` (or `error` if midpoint). Scenario N's `per_scenario_results[N]` left in whatever state the partial run produced — flagged as "incomplete" so the next re-run picks it up. |
| Modal Adapter process restart | Live processing config (which Measurement-Project pair is linked) is **NOT persisted by default** — Project re-opens, but live processing must be re-enabled. The Measurement's recorded scenarios are persisted to disk; user can manually re-process. |

**Recommended: as described above.** Persist live-processing-enabled in `project.json.live_processing.enabled` so on Project re-open the toggle is preserved.

### Q8: Failure handling

**Failure modes:**

| Failure | Today's behaviour | Recommended behaviour |
|---|---|---|
| Recording fails (mic glitch, pause failure) | `_SessionState.phase = "error"`; no scenario_N.npy written | Skip live-processing trigger (no callback fires); user sees error in CollectionLog |
| ESPRIT fails on scenario N (e.g. mapping error, RuntimeError) | Today: front-end-driven loop sees `state: error`, halts | Live-processing: log + flag scenario N as `processing_failed: True` in a new ctx field; do NOT block further recordings; user sees a red dot on scenario N in the chain list |
| Tracking fails (e.g. empty per-scenario results, malformed) | Today: HTTP 500 on `/run_tracking` | Live-processing: log + leave `tracked_chains` unchanged from previous run; do NOT bump version; flag in `live_processing_state.error` for FE display |
| CuPy GPU memory pressure (rare, with many big scenarios in `per_scenario_results`) | Today: silent OOM, hard crash | Add a defensive check + clear cache between scenarios |

**Recommended:** Live-processing failures NEVER block recording. They are surfaced via the
`/collect/status` polling payload (`live_processing.last_error: {scenario, message, ts}`) and
via a new "processing failures" list panel. User can manually retry failed scenarios via a
"Re-process scenario N" button.

### Q9: Data model changes

**`ProjectContext` additions:**

```python
# Live processing fields (new in this proposal)

live_processing_enabled: bool = False
"""True when this Project is configured to live-process scenarios from
its linked Measurement. Set via /modal/projects/live_processing/enable.
Persisted in project.json.live_processing.enabled."""

live_processing_state: str = "off"
"""'off' | 'idle' | 'esprit_running' | 'tracking_running' | 'error'.
Surfaced via /collect/status payload."""

live_processing_active_scenario: Optional[int] = None
"""Scenario index currently being ESPRIT-processed (None when idle)."""

live_processing_last_processed: Optional[int] = None
"""Most recently completed scenario index (None until first success)."""

live_processing_errors: List[Dict[str, Any]] = field(default_factory=list)
"""Per-scenario failure log: [{scenario_idx, phase, message, ts}, ...].
Bounded ring buffer (cap 50)."""

# Concurrency lock (Q2)
_per_scenario_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
_version_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
```

**`MeasurementSession` additions:**

```python
def __init__(
    self,
    backend_url: str = DEFAULT_BACKEND_URL,
    recorder_factory: Optional[Callable[..., Any]] = None,
    collector_factory: Optional[Callable[..., Any]] = None,
    averager: Optional[Callable[[Path], bool]] = None,
    on_scenario_done: Optional[Callable[[str, int, str], None]] = None,  # NEW
):
    ...
    self._on_scenario_done = on_scenario_done
```

The callback is invoked from `_run()` after `_finalize_outputs` returns, before
`_set_phase("resuming")`. Signature: `(measurement_id, scenario_number, scenario_subdir) -> None`.
Failures inside the callback are caught + logged + emitted as a session message; they do NOT
abort the recording session.

**`project.json` additions:**

```json
{
  ...existing fields...,
  "live_processing": {
    "enabled": false,
    "enabled_at": null,
    "last_processed_scenario": null
  }
}
```

**New module: `live_processing_orchestrator.py`** under `pianoid_middleware/modal_adapter/`.
Wraps the callback handler logic, owns the state machine, calls into `EspritOrchestrator` and
`TrackingOrchestrator`. Constructed once on the facade.

**Modifications to existing modules:**

| Module | Change |
|---|---|
| `modal_adapter.py` (facade) | Construct `LiveProcessingOrchestrator(ctx, esprit, tracking)` in `__init__`. Wire `MeasurementSession`'s `on_scenario_done` callback to point at it. |
| `project_context.py` | Add the 5 new fields above + 2 new locks. Wave 3 of the split proposal will absorb these into the facade's eventual `live_processing_orchestrator` ownership. |
| `measurement_routes.py` | No new routes; extend `/collect/status` payload to include `live_processing` block when the active session's measurement_id matches the open Project's measurement_id. |
| `pipeline_routes.py` (or new `live_processing_routes.py`) | New endpoints: `POST /modal/projects/live_processing/enable`, `POST /modal/projects/live_processing/disable`, `POST /modal/projects/live_processing/retry/<scenario_idx>`. |

### Q10: UI / UX flow

**Current UX (sequential):**

```
1. User opens Collection subpanel, selects Measurement M.
2. User records scenarios 0..N.
3. User opens Project subpanel, creates Project P from Measurement M.
4. User goes to "Setup" section, runs ESPRIT.
5. User goes to "Tracking" section, runs tracking.
6. User views stab diagram in "Results" section.
```

**New UX (live):**

```
1. User opens Collection subpanel, selects Measurement M.
2. User opens Project subpanel, creates Project P from Measurement M
   (OR opens existing Project P that's already linked to M).
3. User toggles "Live processing: ON" — a new control in either subpanel.
   Backend records (P, M) as the live-processing pair.
4. User records scenario 0. Behind the scenes:
   - phase: pausing -> recording -> saving -> RESUMING -> (callback fires)
   - LiveProcessingOrchestrator: state=esprit_running, scenario=0
   - Wait ~5-10s
   - state=tracking_running
   - Wait ~1-3s
   - state=idle, tracked_chains_version++
   - phase: done
5. CollectionLog shows:
   "Scenario 0 recorded -> 12 modes extracted -> 8 chains updated."
6. Stab diagram (if user has Project subpanel open + Results tab visible)
   auto-refreshes via the existing version-bump watcher.
7. User records scenario 1. Same loop.
8. User records 30 scenarios. Stab diagram fills in chain by chain.
9. User toggles "Live processing: OFF" when done (or leaves on; it
   doesn't hurt). User now has a fully-processed Project; can go to
   "Apply" section.
```

**UI additions:**

| Component | Change |
|---|---|
| **`CollectionSubpanel`** | Add a "Live Processing" status chip in the header. Three states: "OFF" (grey) / "ON — Idle" (green) / "ON — Processing scenario N" (blue, pulsing). Tooltip explains. |
| **`CollectionSubpanel`** | "Live Processing" toggle button — enabled only when a Project is open AND its measurement_id matches the selected Measurement. Disabled with explanatory tooltip otherwise. |
| **`CollectionLog`** | New event types: `live_processing_start`, `live_processing_esprit_done` (with mode count), `live_processing_tracking_done` (with chain count delta), `live_processing_error`. Color-coded. |
| **`ProjectSubpanel`** (Setup section) | New status panel showing "Source Measurement: M (Live = ON, last scenario processed: 14)". The "Run ESPRIT" / "Run Tracking" buttons get a "Live processing is on — these run automatically" hint. |
| **`StabilizationDiagram`** | Already responds to `tracked_chains_version` (round-21). New: a small "Live" badge in the corner when live-processing is on, indicating the chart auto-updates. |

**Three-principle compliance** (`project_frontend_state_principles.md`):
1. **Single source of truth = backend.** The toggle state IS in `project.json.live_processing.enabled`. Frontend reads it on Project open; mutates via REST.
2. **Granular writes.** Toggle is one POST. Per-scenario completion is one event in the polled `/collect/status` payload.
3. **No speculative emits.** Toggle is set in user-click handler; no `useEffect` re-emitting.

### Q11: Persistence

The live-processing enabled flag goes in `project.json.live_processing.enabled` (Q9). The
`last_processed_scenario` is also persisted to project.json — so on Project re-open, the FE
knows which scenarios have been processed (and which scenarios are present in `per_scenario_results`
matches what was processed last session).

Per-scenario errors (Q8) are NOT persisted today. They live in memory in `ctx.live_processing_errors`
and are surfaced via `/collect/status`. On Project close, they are discarded. This is
acceptable because re-opening the Project will not retry processing automatically (the user
explicitly triggers a retry). If the user wants a persistent error log, that's a follow-up.

### Q12: Sequencing vs the modal-adapter-split-2026-05-21 Wave 3

The modal-adapter-split proposal has Wave 3 pending (ProjectStore, ChainEditor, facade rewrite).
Wave 3 will:
- Move `ctx.chain_undo_stack` / `ctx.chain_redo_stack` to `ChainEditor`.
- Rewrite the facade to ~400 LOC of pure delegation.
- Restate the ProjectContext field set.

If live-processing ships BEFORE Wave 3:
- The 5 new ctx fields are added now; Wave 3 redistributes them later (likely:
  `live_processing_enabled`/`last_processed`/`errors` stay on ctx; the state machine moves
  into a new `LiveProcessingOrchestrator` module which is itself co-equal to EspritOrchestrator/TrackingOrchestrator).
- New `LiveProcessingOrchestrator` module lands as a new module in
  `pianoid_middleware/modal_adapter/`; it follows the post-split convention from Wave 2
  (stateless service, ctx + DI callbacks).
- The facade gets one new field (`self._live_processing`) — but is already growing, so this
  is fine.

If live-processing ships AFTER Wave 3:
- Cleaner — the facade is small + the orchestrators are well-defined.
- Cost: Wave 3 is still pending; live-processing waits.

**Recommended: ship live-processing in parallel with Wave 3 (different files, no overlap).**
The MODULE_LOCKS.md entry for live-processing locks the new module + the facade-level wire-up
hunk in `modal_adapter.py`; Wave 3's lock is on the existing methods being moved. As long as
Wave 3's lock is set BEFORE live-processing edits the facade, the two waves don't conflict.

---

## 4. Decision Summary

| Q | Recommended decision | User confirms? |
|---|---|---|
| Q1 | Model D (process on recording thread); fallback E if CuPy probe fails | ⬜ |
| Q2 | Hybrid B+C: per-field locks for incremental dicts; rebind+grab for full replacements; explicit lock on version counter | ⬜ |
| Q3 | In-process callback on `MeasurementSession.on_scenario_done` | ⬜ |
| Q4 | Per-scenario re-tracking initially; debounce-merge if needed later | ⬜ |
| Q5 | REST polling (extend existing `/collect/status`); no SocketIO on port 5001 | ⬜ |
| Q6 | Single Project, lives forever, accumulates scenarios; N5 snapshot remains frozen-at-create | ⬜ |
| Q7 | State machine + user actions as described (close-project → off, pause → catch-up, cancel mid-ESPRIT → partial) | ⬜ |
| Q8 | Live-processing failures never block recording; surfaced in `/collect/status` payload + retry button | ⬜ |
| Q9 | 5 new ctx fields + 2 locks + `on_scenario_done` callback on `MeasurementSession` + `project.json.live_processing` block | ⬜ |
| Q10 | Toggle in `CollectionSubpanel` header; new event types in `CollectionLog`; status panel in `ProjectSubpanel` Setup; "Live" badge on `StabilizationDiagram` | ⬜ |
| Q11 | Enabled flag + last_processed scenario persisted; errors in-memory only | ⬜ |
| Q12 | Ship in parallel with Wave 3 (different files); MODULE_LOCKS coordination | ⬜ |

---

## 5. UI / UX Detail

### 5.1 Collection subpanel header (new chip)

```
+-------------------------------------------------------------------------+
| Measurement: [Belarus-2026-05-22] ▼   [Add Scenarios] [Manage] [+ Proj] |
|                                                                         |
| Live Processing:  ● ON — Idle                                           |
|                    [Pause] [Disable]                                    |
|                                                                         |
| Linked Project: PlyWoodLGtemp1_p1                                       |
| Last processed scenario: 14   Latest tracked: 23 chains                 |
+-------------------------------------------------------------------------+
```

When no Project is open (or Project's measurement_id ≠ selected Measurement):

```
| Live Processing:  ○ OFF                                                  |
|                    Open a Project linked to this Measurement to enable.  |
```

When a scenario is being processed:

```
| Live Processing:  ◐ ON — Processing scenario 15 (ESPRIT)                |
```

### 5.2 CollectionLog event examples

```
[14:23:01]  scenario_15  Recording started
[14:23:08]  scenario_15  Recording finished → ModalAdapter-Scenario15-Run
[14:23:08]  scenario_15  Live processing: ESPRIT starting (10 bands)
[14:23:13]  scenario_15  Live processing: ESPRIT done — 12 modes extracted
[14:23:14]  scenario_15  Live processing: tracking done — 23 chains (Δ +1)
[14:23:14]  scenario_15  Done

[14:23:30]  scenario_16  Recording started
[14:23:37]  scenario_16  Live processing: ESPRIT FAILED — RuntimeError: no response channels
                          Click here to retry once you've fixed the mapping.
```

### 5.3 ProjectSubpanel — Setup section additions

```
+--- Live Processing -----------------------------------------------+
| Source Measurement: Belarus-2026-05-22 (linked)                  |
| Live Processing: ON                            [Disable]          |
| Scenarios processed: 14 of 28 (50%)                              |
| Last processed: scenario 14 at 14:23:14                          |
| Errors (3):                                                       |
|   • scenario 7 — ESPRIT: empty response channels                  |
|   • scenario 12 — tracking: no chains converged                   |
|   • scenario 16 — ESPRIT: RuntimeError: …             [Retry all] |
+-------------------------------------------------------------------+
```

The existing "Run ESPRIT" / "Run Tracking" buttons get a banner:

```
ⓘ Live processing is ON. ESPRIT and Tracking run automatically as new
  scenarios are recorded. Click the buttons below only to manually
  re-run on all scenarios (e.g., after changing the mapping).
```

### 5.4 StabilizationDiagram — Live badge

A small "● LIVE" badge in the top-right corner when `live_processing_enabled` is true. Same
ECharts re-mount on `tracked_chains_version` bump pattern (round-21) — already wired.

---

## 6. Implementation Phase Breakdown

Three waves, each independently mergeable.

### Wave 1 — Plumbing (~600 LOC moved/added, ~400 LOC new tests)

**Goal:** Backend infrastructure (no user-visible feature). Validates Q1 (CuPy probe).

**New files:**
- `pianoid_middleware/modal_adapter/live_processing_orchestrator.py` — the orchestrator,
  no callback wired yet
- `tests/integration/modal_adapter/test_live_processing_orchestrator.py` — unit tests
  against a mock context
- `tests/integration/modal_adapter/test_cupy_recording_thread_probe.py` — **the gating
  CuPy probe**: instantiate `EspritRunner` from inside a daemon thread (matching
  `MeasurementSession`'s thread family) and verify it completes. If this test deadlocks,
  fall back to model E for Wave 2.

**Modified files:**
- `project_context.py` — add 5 new fields + 2 locks
- `collection_engine.py` — add `on_scenario_done` constructor arg; invoke from `_run()`
  after `_finalize_outputs`
- `modal_adapter.py` — construct `LiveProcessingOrchestrator`; wire `MeasurementSession`'s
  callback to its `handle_scenario_done` method (initially a no-op stub that just logs)

**Acceptance:**
- CuPy probe test passes (or test fails AND we have the model-E fallback plan
  documented before Wave 2)
- All existing tests still pass (no behaviour change)
- The new orchestrator is a stub: callback fires, it logs, it doesn't run ESPRIT yet

**PR sizing:** ~1,000 LOC delta (600 + tests). Single PR.

### Wave 2 — Happy path (~800 LOC, ~500 LOC new tests)

**Goal:** Full happy-path live processing. Cancel/pause/error paths come in Wave 3.

**New files:**
- `pianoid_middleware/modal_adapter/routes/live_processing_routes.py` — the 3 new endpoints
- `PianoidTunner/src/hooks/useLiveProcessing.js` — the FE hook for the toggle + poll-derived
  status
- `tests/system/test_live_processing_e2e.py` — full record-1-scenario-and-verify-processing
  test (requires fake recorder, fake CuPy → already injectable via existing
  `_recorder_factory`/etc.)

**Modified files:**
- `live_processing_orchestrator.py` — fill in `handle_scenario_done`: call
  `EspritOrchestrator.run_esprit(scenario_indices=[N])`, then
  `TrackingOrchestrator.run_tracking()`. Update state fields. Bump version.
- `measurement_routes.py` — extend `/collect/status` payload to include `live_processing`
  block when measurement_id matches open Project's measurement_id
- `modal_adapter.py` — add `is_live_processing_eligible(measurement_id) -> bool` helper
  (Project open AND its measurement_id matches)
- `routes/project_routes.py` — `create_project_from_measurement` opt-in: include
  `live_processing_enabled: true` in body to enable on create
- `CollectionSubpanel.jsx` — add header chip + toggle button
- `CollectionLog.jsx` — render new event types
- `ProjectSubpanel.jsx` — add live-processing status panel in Setup section
- `useModalAdapter.js` — expose `liveProcessing` block from latest `/collect/status` payload
  via the existing polling cadence; ensure `tracked_chains_version` watcher still fires

**Acceptance:**
- End-to-end test: spawn fake recorder, record 3 scenarios, assert
  `per_scenario_results` grows by 3 + `tracked_chains_version` bumps 3 times
- Frontend test: toggle on, polled status payload includes `live_processing`,
  CollectionLog renders the new event types
- Live-verified: user records 1 real scenario, sees chain count go up
- Regression: existing collection tests still pass

**PR sizing:** ~1,500 LOC delta. Single PR (FE + BE coordinated). Could split into BE-first
+ FE-second if review burden warrants.

### Wave 3 — Error handling + UX polish (~400 LOC, ~300 LOC new tests)

**Goal:** Cancel/pause/error paths + per-scenario retry + persistence.

**New endpoints:**
- `POST /modal/projects/live_processing/disable` (already toggleable via enable, but explicit
  disable mid-processing kills the in-flight processing for the current scenario only — next
  scenario won't be processed)
- `POST /modal/projects/live_processing/retry/<scenario_idx>` — manually retry a failed scenario

**Modified files:**
- `live_processing_orchestrator.py` — wire `_cancel_event` for mid-ESPRIT cancellation;
  populate `ctx.live_processing_errors` on failures
- `project_context.py` — `live_processing_errors` ring buffer
- `routes/project_routes.py` — persist `live_processing.enabled` + `last_processed_scenario`
  to project.json on update
- `useLiveProcessing.js` — surface error list; expose retry callback
- `ProjectSubpanel.jsx` — render error list with retry buttons
- `CollectionSubpanel.jsx` — handle "Pause" semantics (records still allowed, processing skipped)
- `useModalAdapter.js` — reload `live_processing_enabled` on project switch

**Acceptance:**
- Failure injection test: ESPRIT raises mid-recording, recording finishes successfully,
  error appears in `/collect/status`, user retries via REST → ESPRIT runs again
- Cancellation test: mid-ESPRIT cancel via `/modal/cancel`, scenario marked incomplete,
  state goes to idle, next scenario processes normally
- Persistence test: close + reopen project; live-processing toggle preserved

**PR sizing:** ~700 LOC delta. Single PR.

### Optional Wave 4 — Performance + advanced

- Debounce-merge (Q4 model C) if per-scenario re-tracking proves slow
- Per-scenario QC integration (effective-signal-length runs live)
- SSE replacement for polling if a user reports update latency annoyance
- "Live preview" mode (Q6 model B) if user wants disposable preview Projects

Not in this proposal's scope.

---

## 7. Backward Compatibility

| Surface | Impact |
|---|---|
| REST API | All new endpoints are additive. `/collect/status` payload gains a `live_processing` block (optional — clients ignore unknown keys); existing fields unchanged. |
| Project schema | New `live_processing` block in `project.json`; v1 v2 schema-version unchanged. Old projects open fine — `live_processing` defaults to `{enabled: false}`. |
| Existing tests | No method moves; no signature changes. New tests added under `tests/integration/modal_adapter/test_live_processing_orchestrator.py` + `tests/system/test_live_processing_e2e.py`. |
| Frontend | New header chip + status panel are additive; default state is "OFF" so existing UX is unchanged unless user opts in. |
| MeasurementSession singleton | Still a singleton; `on_scenario_done` callback is optional (defaults to None). Old callsites that construct `MeasurementSession` without the callback work unchanged. |

---

## 8. Risk Areas + Mitigations

### Risk 1: CuPy deadlock on the recording thread

The whole design rests on CuPy working from the `MeasurementSession._run` thread. The
current "CuPy deadlocks in threads" rule was observed for Flask request handler threads;
whether it applies to all non-main threads is not measured.

**Mitigation:**
- Wave 1 ships **only the CuPy probe test**. If it deadlocks, model D is dead and we
  switch to model E (drain-on-Flask-main) before Wave 2 ships.
- The probe test is run on every CI build (not just once); CUDA driver updates can
  change the behaviour.

### Risk 2: Lock contention during rapid recording

If the user records back-to-back faster than processing finishes, the `_per_scenario_lock`
sees contention between the recording thread's `update()` and the Flask handlers reading
the results.

**Mitigation:**
- Locks are held only for the duration of dict mutation/iteration (~µs scale).
- The single-active-session rule already serialises recordings.
- Stress test in Wave 2 — record 10 scenarios as fast as the recorder allows, verify no
  data loss + no deadlock.

### Risk 3: tracking re-run on growing per_scenario_results is O(N²) over a long session

Each scenario triggers a full tracking re-run over all N scenarios. After 100 scenarios that's
~10s per re-run; total per-scenario tail becomes 15s+.

**Mitigation:**
- Acceptable for normal session sizes (≤50 scenarios in a session).
- Wave 4's debounce-merge handles the heavy case if it materialises.
- Tracking config exposes a "skip live-tracking, keep live-ESPRIT" toggle as a Wave-3
  escape hatch.

### Risk 4: Live processing leaves the Project in an inconsistent state on crash

Modal Adapter process dies mid-ESPRIT for scenario N. `per_scenario_results[N]` may be
partially written to disk. On restart, the Project loads partial results → tracking sees
malformed input → tracking errors.

**Mitigation:**
- `_persist_esprit_results` already writes per-scenario JSON atomically (writes to temp,
  renames). One scenario's partial state at most.
- Tracking already has empty-input handling.
- A "validate per-scenario results on open_project" check could be added as a follow-up.

### Risk 5: User changes the Measurement's setup mid-session (e.g. swaps the mic)

The Project's `measurement_snapshot` is frozen. New scenarios recorded with a different
setup will produce inconsistent ESPRIT results (different mapping, different channel roles).
The Project doesn't know.

**Mitigation:**
- Document the constraint: "Live processing assumes the Measurement setup is stable for
  the session. Changing setup mid-session yields inconsistent results."
- A future enhancement could detect setup divergence (compare `measurement_snapshot` against
  current Measurement's `setup/*`) and warn the user.
- Out of scope for this proposal.

### Risk 6: Frontend polling cadence misses transient state

Frontend polls `/collect/status` at 1s. ESPRIT for one scenario takes ~5-10s; tracking
~1-3s. Total processing tail ~6-13s — covered by 6-13 polls. No state should be missed.

**Mitigation:**
- The `tracked_chains_version` is monotonic. Even if a poll misses the transient
  `esprit_running` state, it sees the post-tracking version bump and refetches.
- The "last_processed_scenario" is persistent in `project.json` — if the frontend reloads,
  it sees the last completed processing.

### Risk 7: Coordination with Wave 3 of modal-adapter-split

Wave 3 will move ChainEditor's undo/redo stacks; the new live-processing fields might
conflict with Wave 3's redistribution.

**Mitigation:**
- New live-processing fields are isolated — none overlap with Wave 3's targets
  (chain_undo/redo_stack).
- MODULE_LOCKS.md coordinates the facade-level wire-up edits.
- Live-processing PR description explicitly cross-references modal-adapter-split-2026-05-21
  Wave 3 status.

---

## 9. Open Questions (need user input before Wave 1 dispatches)

| # | Question | Default if no answer |
|---|---|---|
| OQ1 | Q1 — model D (process on recording thread) vs. start with model E (queue-and-drain on Flask main) for safety? | Start with D + CuPy probe gate; switch to E if probe fails |
| OQ2 | Q4 — per-scenario re-tracking initially (proposal), or debounce-merge from day one? | Per-scenario; revisit if rapid-recording is observed |
| OQ3 | Q5 — REST polling (proposal) vs. add Flask-SocketIO / SSE for push notifications? | REST polling; revisit if push latency becomes a felt issue |
| OQ4 | Q6 — single Project model (proposal) vs. live-preview + final Project? | Single Project; the N5 snapshot already accommodates this |
| OQ5 | Q9 — name the new orchestrator `LiveProcessingOrchestrator` or something shorter (e.g. `LiveProcessor`)? | `LiveProcessingOrchestrator` (matches Wave 2's `EspritOrchestrator`/`TrackingOrchestrator` naming) |
| OQ6 | Q10 — toggle lives in `CollectionSubpanel` header (proposal), or `ProjectSubpanel` header, or both? | Both — primary toggle in `CollectionSubpanel`, mirror in `ProjectSubpanel` |
| OQ7 | Q11 — persist `live_processing.enabled` per Project (proposal), or per User (single global preference)? | Per Project; matches existing per-project config pattern |
| OQ8 | Q12 — ship in parallel with modal-adapter-split Wave 3 (proposal), or wait until Wave 3 lands? | Ship in parallel; coordinate via MODULE_LOCKS |
| OQ9 | Wave sizing — 3 waves as proposed (plumbing → happy → error/UX) or a different split (e.g. backend-first + frontend-second)? | 3 waves as proposed; each wave is independently demoable |
| OQ10 | Cancellation semantics on Project switch — let the in-flight processing finish (proposal), or abort it? | Let it finish to disk; just don't reflect in new Project's version |
| OQ11 | Failure surfacing on the FE — inline in CollectionLog only (proposal), or also as a Snackbar notification? | Inline in log; Snackbar feels nagging for the expected "occasional bad scenario" rate |
| OQ12 | Test infrastructure — does `tests/system/test_live_processing_e2e.py` need its own pytest marker (e.g. `@pytest.mark.live`), or fold into existing `tests/system/` discovery? | New marker `live_processing` — these tests are heavier than normal system tests because they exercise the full thread+ESPRIT+tracking loop |

---

## 10. Implementation Log

Populated as each wave ships. Empty at proposal time.

| Wave | Status | Branch | PR / Merge SHA | LOC added | Tests post-wave | Date | Notes |
|---|---|---|---|---|---|---|---|
| Wave 1 (plumbing + CuPy probe) | Pending | TBD | TBD | ~1,000 | TBD | TBD | Gates on CuPy probe outcome |
| Wave 2 (happy path) | Pending | TBD | TBD | ~1,500 | TBD | TBD | Live-verified with real recording |
| Wave 3 (error handling + UX polish) | Pending | TBD | TBD | ~700 | TBD | TBD | Persistence + retry + cancellation |

---

## 11. Investigation history

This proposal was authored as a standalone design round (no prior analysis docs in
`docs/proposals/archive/`). Key context sources reviewed:

- `docs/proposals/modal-adapter-split-2026-05-21.md` Wave 2 implementation log (shipped
  2026-05-17 — orchestrators ready to consume)
- `docs/proposals/modal-adapter-measurement-entity-2026-05-10.md` §3.4 + §5 (N5 frozen
  snapshot contract, v2 collect REST surface)
- `docs/modules/pianoid-middleware/MODAL_COLLECTION.md` (current `MeasurementSession`
  lifecycle, Q8 messages ring buffer)
- `PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py` (single-active-session
  + phase machine)
- `PianoidCore/pianoid_middleware/modal_adapter/esprit_orchestrator.py` (`_run_esprit_sync`
  runs on main thread today, CuPy constraint)
- `PianoidCore/pianoid_middleware/modal_adapter/tracking_orchestrator.py` (full re-track on
  every run; `ctx.tracked_chains_version` bump pattern)
- `PianoidCore/pianoid_middleware/modal_adapter/measurement_routes.py` (collect/start, status,
  cancel route shapes)
- `PianoidTunner/src/hooks/useModalAdapter.js` (`tracked_chains_version` watcher; polling
  cadence)
- `PianoidTunner/src/modules/panels/CollectionSubpanel.jsx` (current Collection UX, hook
  composition)
- `PianoidTunner/server/launcher.js` (raw `ws` broadcast — used only for backend status, not
  modal events)

---

**End of proposal. Awaiting orchestrator confirmation + OQ1..OQ12 answers before Wave 1
dispatches.**
