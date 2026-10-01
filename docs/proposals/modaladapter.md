# Modal Adapter — User-Flow Redesign (Campaign Proposal)

> **Status: Draft (in composition).** Co-built top-down with the operator (mode B — dialog-from-
> scratch). Composition record + AS-IS grounding + reference derivation live in the side seed
> `./.process/modaladapter-seed.md`.
>
> **How to read / governed hierarchy.** Governed top-down: **Purpose → the Flow (the user pipeline —
> the center of this proposal) → Core principles (derived from the flow) → Decision hierarchy →
> Architectural principles → Architecture + flow set → Classification → Modules → Cross-cutting.**
> Every element carries a `traces-to:` tag naming the upstream ID(s) it serves; upstream governs
> downstream; an upstream change re-traces the document. Traceability is carried in the matrices near
> the end, not in inline prose. Settled points that were PUT to the operator are in the Decisions log.

---

## PART 0 — Foundations

### Purpose

Redesign the Modal Adapter's user flow so that turning a physical instrument into a synthesis preset
is one coherent, guided pipeline, and so that the measurement path at its front is one the user can
trust. Today the capture stage has no settled flow — a scatter of separately-grown panels — and its
migrated copy of a known-good RoomResponse measurement procedure is wired but untested: the user
cannot tell whether a capture faithfully performs the correct procedure, nor whether the result is
any good. This campaign designs the capture flow greenfield, from the start of the pipeline up to
**processing**, constrained so that the flow can express the reference procedure exactly and makes
any deviation from it — or any quality failure — visible. From processing onward (mode selection,
adaptation) the existing flow is the presumptive baseline: preserved in substance but re-governed by
the same pipeline, with any change the front-end redesign forces downstream made at the source and
re-traced, never patched locally.

`traces-to:` — (root; everything downstream serves this)

---

### The Flow (user pipeline) — the center of the proposal

The system is interactive, so the flow IS the user pipeline: how an operator goes from a physical
instrument to project-ready measured data (this campaign's scope) and on to a preset (baseline). It
is designed in three rings: **Ring 1** the MVP happy path (LOCKED, below), **Ring 2** the branches
(user-led, in co-design), **Ring 3** errors/robustness (agent-led draft). The main flow is
`FD1`; its sub-loops and branch/robustness flows are `FD2…FD6`.

#### Ring 1 — MVP happy path (LOCKED) · `FD1`

Grounded in and required to be able to express the RoomResponse reference procedure exactly (the
known-good tool at `D:\repos\RoomResponse`; recording hierarchy **cycle → measurement → scenario →
dataset**, two processing **modes** Standard/Calibration, averaging intra-measurement + cross-
measurement-within-scenario only — never across scenarios). Decision **D4** (advisory now, enforced
gate deferred) sets its character: Ring 1 restores the reference's full advisory trust apparatus;
enforcement is a deferred Ring 2/Ring 3 feature.

| Stage | The user does | Produces / guarantees | Serves |
|-------|---------------|-----------------------|--------|
| **A · Configure the rig** | Enters directly on capture within a Measurement session (one rig = one Measurement). Sets audio devices + channel roles (channel count/names, which is the **calibration/force** channel, which is **reference**, which are **response**). Chooses the recording **MODE** — Standard vs Calibration — made explicit because it selects the entire downstream processing path. Calibration is the default when a calibration channel is set (matching the reference). | A single canonical setup owned in one place; mode chosen consciously, never silently defaulted. | CP1, CP3, CP4 · `FD1` |
| **B · Design & tune the excitation** | Designs the pulse (voice_coil / sine / square) with the **full** parameter set (incl. `voice_coil_config` ramps, `pulse_smoothing_ms`, `invert_polarity`) + series timing + volume, with a live preview. In Calibration mode, defines or **learns** the per-cycle quality criteria. | An excitation the engine actually emits as designed; criteria the operator understands. | CP1, CP2 · `FD1` |
| **C · Validate the setup (iterative)** · `FD2` | Fires **Test Pulse** (one pulse; emitted-vs-recorded overlay → actuator + sensor alive and clean). Runs a **Record-Series dry run** (one throwaway full train) and reads the analysis — valid-cycle %, alignment correlation, cycle-consistency overlay, peak ratio ≈ 1.0. Iterates B↔C until satisfied. | Evidence, before committing, that a real capture will be trustworthy (advisory — D4). | CP2, CP1 · `FD2` |
| **D · Capture the dataset (scenario loop)** · `FD3` | Captures **scenario N** = `num_measurements` repeats at the current position, with live per-measurement feedback; scenario **number** is first-class (not a hardcoded 0). Repositions the actuator (manual bench action, the flow cues the window) and captures the next scenario; repeats per position. | A set of scenarios, each averaged over its measurements; a calibration measurement with zero valid cycles hard-stops that scenario (the reference's sole enforced stop). | CP1, CP2 · `FD3` |
| **E · Review & finalize** · `FD4` | Reviews set quality (split-half reproducibility / effective-signal-length), re-captures bad scenarios, finalizes. | Per-scenario averaged responses stamped with the **processing path/mode** that produced them (no silent mixing), handed to the settled processing stage (create analysis Project → ESPRIT). | CP2, CP3 · `FD4` |

#### Ring 2 — branches (user-led; candidate set, in co-design)

Each is a real branch off `FD1`; the set + priority is the next operator decision. Candidates:
`import an existing dataset instead of capturing (FD5)`; `add scenarios to an existing Measurement`;
`re-capture a bad scenario`; `unlock + edit a sealed Measurement (N4)`; `many Projects from one
Measurement (N5 branch)`; `the deferred enforced trust-gate (D4)`. None is locked here.

#### Ring 3 — errors / robustness (agent-led draft) · `FD6`

Server-off / device-not-found surfaced (not silently polled); pause/resume-synth failure fails fast
without opening the device; cancel mid-capture always resumes synthesis; the zero-valid-cycles hard
stop; **detection + refusal of a mode/path mismatch** (e.g. standard-mode averages about to feed a
calibration project) — the robustness face of CP3.

---

### Core principles (derived from the locked flow)

| ID | Principle | Serves (flow) |
|----|-----------|---------------|
| **CP1** | **Express the reference exactly.** The flow can express every stage and parameter the known-good RoomResponse procedure performs (mode, channel roles, full excitation incl. `voice_coil_config`, learnable per-cycle criteria, series timing); any deviation from the reference is visible, never silent. | A, B, C, D · `FD1/FD2/FD3` |
| **CP2** | **Know it's good.** At every commit point the user can see whether the capture is trustworthy — Test Pulse, dry-run analysis, per-measurement validity, set-level reproducibility. Trust is advisory now (D4); enforcement deferred. | B, C, D, E · `FD2/FD3/FD4` |
| **CP3** | **No silent path-mixing.** It is impossible to be unaware WHICH processing mode/path produced a given averaged response, and impossible to silently mix them. | A, E · `FD1/FD4/FD6` |
| **CP4** | **One coherent guided pipeline.** Physical instrument → preset is one governed sequence; the capture stage is a first-class, discoverable surface, not a scatter of panels behind a title-bar gear with a Start button on a different surface. | A–E · `FD1` |
| **CP5** | **Single source of truth; corrections flow up.** Each fact (channel roles, mode, averaging length) is owned once and consumed everywhere; a change the early redesign forces downstream is made at the source and re-traced, never duplicated or patched locally. | A, E · `FD1/FD4` |

_(An earlier "learn/tune" candidate folded into CP1+CP2; a "faithful-layout" candidate was dropped —
the reference's Streamlit multi-panel layout is not a principle, only its procedure is. See decision
hierarchy.)_

### Decision hierarchy (resolving CP conflicts)

1. **Correctness of the measurement path is non-negotiable** — **CP1** and **CP3** outrank the rest.
   When faithful procedure/parameters (CP1) or path provenance (CP3) conflict with UX shape (CP4) or
   structural hygiene (CP5), correctness wins.
2. **CP1 governs SUBSTANCE, CP4 governs PRESENTATION.** We may re-arrange the reference's scattered
   panels into a coherent pipeline (CP4), but must not drop or alter any procedure step or parameter
   (CP1). Fidelity-of-substance beats fidelity-of-layout; a nicer flow that cannot express the
   procedure is wrong (CP1 wins).
3. **CP2 is realized as visibility, not enforcement (D4).** Where "know it's good" could mean a hard
   gate, it currently means surfaced evidence; the gate is deferred.
4. **CP5 is a means, not an end** — it yields when it would block shipping the flow, but is otherwise
   binding.

### Architectural principles (realize the CPs)

| ID | Architectural commitment | traces-to |
|----|--------------------------|-----------|
| **AP1** | **One canonical setup model, owned once.** The Measurement `setup/*` (devices, channel roles, mode, full excitation incl. `voice_coil_config`, series timing, per-cycle criteria) is the single source; frontend and both servers consume it — no second owner (kills the double-owned channel mapping). | CP1, CP5 |
| **AP2** | **Explicit processing-path provenance.** Every averaged response records the mode/path that produced it; the flow reads and surfaces it; the two averaging implementations (live acquisition vs import) are reconciled to reference semantics and explicitly labeled. | CP3 |
| **AP3** | **First-class validation service** (rebuilt advisory loop): Test Pulse, Record-Series dry-run analytics, and learnable per-cycle criteria are backend capabilities exposed to the flow — replacing the thin, separate 5-criterion Setup Test. | CP2, CP1 |
| **AP4** | **Faithful excitation generation.** The recorder consumes the full parameterized `voice_coil_config` (via `_compute_pulse_samples`) plus `pulse_smoothing_ms` and `invert_polarity`; emitted excitation matches the reference. | CP1 |
| **AP5** | **Mode is a first-class flow parameter end-to-end.** `recording_mode` is threaded setup → collection_engine → `take_record` (never hardwired `'standard'`); calibration is the default when a calibration channel is set, matching the reference. | CP1, CP3 |
| **AP6** | **One capture surface, layered not scattered.** The capture flow is a single guided surface (stages A–E) with inline, discoverable setup (not an OS title-bar gear), one Start path, and enter-on-capture. | CP4 |
| **AP7** | **Facade frozen; logic in services; state de-duplicated.** `modal_adapter.py` stays frozen (split proposal); new work lands in service modules; duplicated frontend state (channel roles, effective-signal-length QC, modal-mass summary, `serverRunning`, mode) is collapsed to single owners; cross-layer leaks (hardcoded port 5000, relative URLs) removed. | CP5 |

### Overall architecture + flow set

**Layers / actors.** Frontend capture surface (PianoidTunner React) · Modal Adapter server (port
5001, single-threaded for CuPy) owning measurement/collection/validation/averaging + project
management · the vendored measurement stack (`measurement.recorder / dataset_collector /
signal_processor / calibration_validator / missing_averages / …`, the RoomResponse port — the
procedure implementation) · the synthesis engine (port 5000, paused/resumed during capture; the apply
target, later stage) · on-disk entities **Measurement** (`setup/*`, `scenarios/`, validation
artifacts, `locks/`) and **Project** (frozen N5 snapshot + analysis caches).

**Flow set** (derived from the principles): `FD1` capture pipeline (Ring 1 A–E) · `FD2` validate-and-
iterate sub-loop (stage C) · `FD3` scenario capture loop (stage D) · `FD4` provenance/finalize (stage
E) · `FD5` import-instead-of-capture branch (Ring 2) · `FD6` robustness/error flows (Ring 3).

---

## The element body

### Classification + transition graph

The design depends on one taxonomy — the **recording-unit hierarchy** — and its transition graph;
everything in the modules section is homed against it.

```
cycle ──(train of num_pulses)──▶ measurement ──(×num_measurements at ONE position, cycle-averaged in-line)──▶ scenario
        │                                                                                                        │
        │                                              (cross-measurement mean within a scenario, DEFERRED)◀─────┘
        ▼
   mode ∈ {Standard | Calibration}  gates per-measurement processing (validate→align→normalize only in Calibration)

scenario ──(manual reposition; loop over scenario NUMBERS; NO cross-scenario averaging)──▶ dataset
dataset ──(create / branch; N5 snapshot freeze)──▶ Project ──(ESPRIT → tracking → apply; baseline)──▶ preset
```

Consequences the modules must honor: the **scenario** is the unit of the stage-D loop; **cross-
measurement averaging** is the stage-E deferred post-step (owned by one canonical implementation,
AP2); **mode** selects the processing path (AP5) and must be stamped onto the output (AP2).

### Modules (full pipeline — survive / replace / new)

Facade `modal_adapter.py` is **FROZEN**; all new logic lands in service modules (AP7).

**Capture / measurement (the redesign focus).**
- `measurement_entity`, `measurement_catalog` — **SURVIVE.** Entity model is sound and becomes the
  single source of truth (AP1); extended to carry `recording_mode` + processing-path provenance and
  to treat `voice_coil_config` as a first-class consumed field. `traces-to:` CP1, CP5, AP1.
- `collection_engine` (`MeasurementSession`) — **MODIFIED.** Thread `recording_mode` through to
  `take_record` (kill the hardwired `'standard'`); stitch the full setup incl. `voice_coil_config`.
  Work item **WI2**. `traces-to:` CP1, CP3, AP5.
- `measurement.recorder` (vendored) — **REPAIRED.** Restore the parameterized `voice_coil` excitation
  (`_compute_pulse_samples`), `pulse_smoothing_ms`, `invert_polarity`; consume `voice_coil_config`
  (audit-confirmed drift). Byte-faithful processing/averaging methods stay untouched. Work item
  **WI1**. `traces-to:` CP1, AP4.
- `measurement.dataset_collector / signal_processor / calibration_validator / missing_averages /
  filename_utils / mic_testing` — **SURVIVE** (audit: byte-faithful or one-import-line difference).
- `setup_test_engine` — **REPLACED / SUBSUMED** by a first-class **Validation service** (AP3): Test
  Pulse (emitted-vs-recorded), Record-Series dry-run analytics (valid %, alignment correlation,
  cycle-consistency, peak ratio), and learnable per-cycle criteria. The thin 5-criterion Setup Test
  folds in. Work item **WI3** (audit rows #15/#16). `traces-to:` CP2, CP1, AP3.
- `scenario_averager` (import path) — **RECONCILED.** The audit found it (cycle-pooling + re-
  normalize) is the **non-reference outlier**; the reference and the live path use a naive
  cross-measurement mean. Reconcile toward reference semantics and stamp path provenance so the two
  cannot silently mix. Work item **WI4**. `traces-to:` CP3, AP2.
- `measurement_import` — **SURVIVE** (drives Ring 2 `FD5`); made to stamp provenance (AP2).
- `measurement_routes / collection_routes / fs_routes` — **SURVIVE, EXTENDED** with the validation
  service endpoints (Test Pulse, dry-run, criteria learn) and provenance fields.

**Processing (later stage — presumptive baseline, re-governed).**
- `project_store / project_context` — **SURVIVE.** N5 snapshot extended to carry mode/provenance.
- `esprit_orchestrator/esprit_runner`, `tracking_orchestrator/chain_editor`, `feedin_extractor`,
  `frf_orchestrator/modal_mass_orchestrator`, `qc/*`, `apply_service`, `preset_injector` — **SURVIVE**
  (baseline). The `preset_injector` measured-mass → `mass_inv` seam (review §5) is a **separate**
  concern, **OUT OF SCOPE** here unless the operator pulls it in (flagged, not assumed).
- `modal_adapter.py` — **FROZEN** (facade).

**Frontend.**
- `ModalAdapter.jsx` + `useModalAdapter.js` — **REPLACED in the capture region:** a rebuilt guided
  capture surface (stages A–E) replacing the scattered `CollectionSubpanel` + title-bar-gear settings
  + toolbar Start; de-duplicate channel-roles / QC / modal-mass / mode / `serverRunning` state to
  single owners; remove cross-layer leaks (hardcoded 5000, relative URLs). The analysis region
  (Setup/Tracking/Apply) **survives** as baseline. Work item **WI5**. `traces-to:` CP4, CP5, AP6, AP7.
- **NEW** capture-flow components: Test-Pulse overlay, dry-run analysis panel, per-cycle criteria
  editor/learner, scenario-loop panel with first-class scenario number, mode/provenance display.

### Cross-cutting processes / rules / lifecycles

- **Processing-path provenance stamping** (AP2/CP3) — every averaged response carries its mode/path;
  a mode/path mismatch at the processing handoff is detected and refused (Ring 3 `FD6`).
- **Setup single-source-of-truth** (AP1/CP5) — one owner for each setup fact across FE + both servers.
- **Measurement lock lifecycle (N4)** and **Measurement→Project snapshot (N5)** — SURVIVE as-is; the
  redesigned flow makes their state visible in-line rather than via disabled fields + a title-bar gear.
- **Pause/resume-synth coordination** (port 5000) — SURVIVE; the fail-fast (no device open on pause
  failure; always resume on cancel/error) is a Ring 3 obligation.

### Work items (the concrete "fidelity established and kept" content)

| WI | Item | Source | traces-to |
|----|------|--------|-----------|
| WI1 | Restore parameterized `voice_coil` excitation + `pulse_smoothing_ms` + `invert_polarity`; consume `voice_coil_config` | audit-confirmed defect | CP1, AP4 |
| WI2 | Thread `recording_mode`; calibration default when calibration channel set; kill hardwired `'standard'` | audit divergence #1 | CP1, CP3, AP5 |
| WI3 | Rebuild advisory validation loop (Test Pulse, dry-run analytics, learnable criteria) | audit rows #15/#16 | CP2, AP3 |
| WI4 | Reconcile the two averaging paths to reference semantics + stamp provenance | audit (import path = outlier) | CP3, AP2 |
| WI5 | Rebuild the capture surface (enter-on-capture, inline setup, single Start, first-class scenario) + de-dup state + fix leaks | AS-IS friction | CP4, CP5, AP6, AP7 |

---

## Traceability matrices

**Principle → (architectural principles + flows).**

| CP | Architectural principles | Flows |
|----|--------------------------|-------|
| CP1 Express-the-reference | AP1, AP3, AP4, AP5 | FD1, FD2, FD3 |
| CP2 Know-it's-good | AP3 | FD2, FD3, FD4 |
| CP3 No-silent-path-mixing | AP2, AP5 | FD1, FD4, FD6 |
| CP4 Coherent guided pipeline | AP6 | FD1 |
| CP5 Single-source-of-truth | AP1, AP7 | FD1, FD4 |

**Element → (principles + flows + kind).**

| Element | Kind | Principles | Flows |
|---------|------|-----------|-------|
| Ring 1 stages A–E | flow | CP1–CP5 | FD1 |
| Validation service (ex-`setup_test_engine`) | module | CP2, CP1 | FD2 |
| `measurement.recorder` (WI1) | module | CP1 | FD1 |
| `collection_engine` (WI2) | module | CP1, CP3 | FD1, FD3 |
| `scenario_averager` reconcile (WI4) | module | CP3 | FD4 |
| Capture surface rebuild (WI5) | module | CP4, CP5 | FD1 |
| Provenance stamping | cross-cutting | CP3 | FD4, FD6 |
| Setup single-source | cross-cutting | CP1, CP5 | FD1 |
| Recording-unit hierarchy | classification | CP1 | FD1, FD3, FD4 |

---

## Decisions log

| # | Topic | Decision |
|---|-------|----------|
| D1 | Scope fork | Measurement PROCEDURE is correctly defined by a known-good RoomResponse REPL; MA's migrated copy is wired-but-untrusted (fidelity audited separately). Two joined concerns: **correctness** (feeds Modules) + **user flow** (this proposal). |
| D2 | Settled/open boundary | User flow is **fully open from the start of the pipeline up to *processing***; from processing → mode selection → adaptation it is the presumptive baseline. |
| D3 | Purpose | Settled per D1/D2 (above). |
| D4 | Trust: advisory vs gate | **(c) advisory now, gate later** — PUT to the operator. Ring 1 restores the reference's full advisory evidence arc faithfully; the enforced trust-gate is a **deferred** Ring 2/Ring 3 feature, to be decided after the restored flow is used. Rationale: the advisory loop was never ported, so faithful restoration is the substance of Ring 1; enforcement is a secondary feature best judged from experience. |
| D5 | Audit verdict (final) | Port semantically faithful EXCEPT `recorder.py` excitation (DRIFTED — WI1) and hardwired standard-mode in `collection_engine` (divergence #1 — WI2); advisory loop + learnable criteria not ported (rows #15/#16 — WI3); import-path `scenario_averager` is the non-reference outlier, not the canonical path (WI4). Naive live averaging REFUTED as a defect. Downstream magnitude / production-project contamination / frontend-loop status remain UNVERIFIED — not assumed. |

_(D4/D5 locked this turn; Ring 2 branch set + priority is the next open decision.)_
