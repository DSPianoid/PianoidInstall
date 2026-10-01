# ModalAdapter Campaign — Composition Seed (process record)

> Side seed for `docs/proposals/modaladapter.md`. Holds the design-evolution log, per-decision
> notes, superseded framings, and the grounding record. The proposal stays lean; this is the memory.
> Build mode: **B — DIALOG-FROM-SCRATCH** (flow is being redesigned, structure uncertain, high-stakes).

## Governing directive (verbatim, operator)

> "Your task is to redesign the user flow for model adapter. It is mostly OK in the later stages.
> Early stage, the measurement itself is the problem at the moment. So the complete pipeline has to
> be designed and all the modules."

Reading: USER-FLOW REDESIGN of the Modal Adapter. Later stages mostly acceptable as-is. Early stage
— the measurement capture itself — is the problem. The COMPLETE pipeline and ALL modules must still
be designed end-to-end (governance does not stop at the measurement stage). Flow is the center of
the proposal; principles are DERIVED from the flow.

## Grounding sources consulted (Phase 1)

- `docs/development/reviews/modal-measurement-review-2026-07-10.md` (today's read-only analysis — pipeline table, structural findings, open questions, data-model facts).
- `docs/guides/MODAL_ADAPTER_GUIDE.md` (pp. 1-991 read; 2993 total — later pages cover Tracking/Apply/export).
- `docs/modules/pianoid-middleware/MODAL_COLLECTION.md` (pp. 1-1009 read; 1316 total).
- Frontend AS-IS reconstruction (Explore agent) — early-stage user flow + friction list.
- Backend AS-IS reconstruction (Explore agent) — measurement entity, capture loop, setup test, averaging, import, REST, Measurement→Project seam.

## AS-IS pipeline (as it runs today)

collection_engine (MeasurementSession, port-5001) → measurement_entity/catalog → setup_test_engine →
scenario_averager → project_store (create_project_from_measurement, N5 snapshot freeze) →
esprit_orchestrator/esprit_runner → tracking_orchestrator/chain_editor → feedin_extractor →
frf_orchestrator/modal_mass_orchestrator → qc/apply_service → preset_injector (into port-5000 engine).

Two entities: **Measurement** (raw captures + setup, auto-locks after first scenario = N4) and
**Project** (analysis decisions branched from a Measurement, freezes a setup snapshot = N5).

## AS-IS EARLY-STAGE USER FLOW (happy path, capture)

1. Panel opens on **Setup (Project)** subpanel — NOT Collect (`ModalAdapter.jsx:119` default `"setup"`). User must click **Collect**.
2. Check server chip (5001); if off, click to start. Failures poll silently.
3. Collect subpanel; Record|Synthesize toggle.
4. Select/create a **Measurement** (MeasurementSelector). New = globally-unique non-renameable ID (N1).
5. Pre-flight **Setup Test banner** (info/pass/warn/fail).
6. Open the **5-section setup editor** — reachable only via a **gear icon portalled into the OS Mosaic title bar**, not inline.
7. Edit 5 sections (General/Audio/Impulse/Series/Calibration), each with its own staged state + Save Settings.
8. Run a **Setup Test** (3 surfaces share one hook; one calibration cycle vs calibration_criteria.json).
9. **Start Collection** — button lives in the shared TOOLBAR (gated on `activeSection==="collect"`), hardcodes scenario 0. Records ONE scenario; N4 auto-locks after the first.
10. Watch streaming **CollectionLog** (1 Hz poll of active_session).
11. (Optional) **Unlock with warning** (N4) to edit setup or add scenarios.
12. **+ New Project from this Measurement** → averages scenarios → opens Project → switches to Setup. One-way crossing.

## AS-IS EARLY-STAGE FRICTION POINTS (measured, concrete)

1. **Wrong default section** — opens on Setup, not Collect; no nudge toward capture.
2. **Headline setup editor hidden in the OS title-bar gear** — poor discoverability, undocumented in-UI; invisible if portal host absent.
3. **Two Start-Collection surfaces** — real one in toolbar, body one is a suppressed back-compat fallback; reading the body, user sees no Start.
4. **Start always records scenario 0** — no scenario/position picker on this surface.
5. **Setup-Test gate documented but NOT enforced** — red fail does not block Start; "Proceed anyway" affordance never wired. Gate is advisory-in-fact, blocking-in-docs.
6. **"Save All" is a trap** — re-PATCHes current manifest, not each section's staged edits; silently drops unsaved edits.
7. **Lock is all-or-nothing, cross-cutting** — locks all of General/Audio/Impulse/Series; only Calibration exempt; must-unlock-before-edit only signaled by disabled fields.
8. **Modal-on-modal** — Manage Measurements → nested Delete/Rename/Add-Scenarios(ImportScenariosDialog) → progress panel = up to 3 stacked modals.
9. **Two entry points to the identical Add-Scenarios dialog** (header vs per-row in Manage).
10. **Create-Project dialog fragile** — must stay open through a transactional result panel (switching section unmounts its owner); 60-min poll cap can orphan a project.
11. **Silent server-off failures** — status polls swallow errors; log shows "(no messages)", phase stays idle, no error surfaced.
12. **Two panels edit the SAME mapping/grid** against two backends — Collection>General edits Measurement `mapping_config` (PATCH /modal/measurements/<id>/mapping_config); Project subpanel edits project-level mapping (POST /modal/mapping). Separate stores; no reconciliation. (Also a structural-debt item.)

## Cross-layer leaks (structural, early stage)

- `MeasurementTimingPanel.jsx` hardcodes port-5000 `/calibration_params` (wrong server, no hook).
- `CreateProjectFromMeasurementDialog.jsx` uses relative-URL axios/fetch (import_operations status/cancel, projects/delete, effective_signal_length) — relies on CRA proxy, not the injected `url` prop.
- `ModalAdapter.jsx:587` relative `/modal/projects/<n>/effective_signal_length`.
- Effective-signal-length QC fetched in 3 places; modal-mass summary owned twice; channel roles owned twice; `serverRunning` mirrored.
- `applyToPreset` → port 5000 is the INTENDED exception (apply mutates the running engine).

## KEY DATA-MODEL SEAM (from review §5/§7)

Engine mode carries 3 tunable coefficients: `dec`, `omega`, `mass_inv` (JSON `"mass"`). `preset_injector`
writes frequency→dec/omega + deck/sound-channel coupling but NEVER writes `mass_inv`. Per-mode relative
modal mass IS measured (FRF residue kernels, Phase-2 shipped) but kept read-only. Whether the redesigned
flow closes this loop is an OPERATOR DECISION, not to be assumed.

## In-flight proposals (collision map)

- `modal-adapter-split-2026-05-21.md` — IMPLEMENTED (3 waves merged). Facade `modal_adapter.py` treat as FROZEN; new work in service modules.
- `modal-adapter-facade-shim-removal-2026-06-06.md` — PROPOSED, not started. Cosmetic LOC tail.
- `modal-mass-q-factor-2026-05-24-merged.md` — PARTIAL. Owns the measurement-side mass work; boundary, not hard collision.
- `modal-adapter-measurement-entity-2026-05-10.md` — the entity split (Measurement/Project) authoritative spec; all 16 decisions (N1..N8 etc.) baked in.
- `live-processing-flow-2026-05-22.md`, `BRIDGE_FROM_GRID.md` — related; grid layout deferred.

One-doc-per-topic: assess whether these consolidate into this campaign or archive. RECOMMEND only —
no git mv without operator approval.

## DESIGN LOG (topic by topic)

### PART 0 · Topic 1 — Purpose  [IN DIALOG]
- Draft v1 sent to operator, plus the single most-constraining scope question.
- Scope-fork resolved by operator (two verbatim messages):
  1. "the measurement algorithm itself supposed to be wired but not tested and I'm not sure if it is
     intact. The reference is can be found in a room response REPL. This is a working REPL where exact
     measuring procedure is working as it is supposed to work so you can verify ... model adapter
     against room response folder."
  2. "the user flow is not settled for measurement itself, it's more or less settled from processing,
     mode selection and adaptation, but before that it's fully open."
- Resolution = fork (c), sharper (NOT "reinvent the method"): procedure is CORRECT and defined by the
  RoomResponse reference; MA's copy is wired-but-untrusted. Two joined concerns → D1. Boundary at
  *processing* → D2. Purpose settled → D3.
- CORRECTNESS (algorithm fidelity vs reference) audited by a SEPARATE agent →
  `docs/development/reviews/measurement-vs-roomresponse-differential-2026-07-10.md`. Do NOT duplicate;
  verdict feeds MODULES, not FLOW; do not assume it — mark module deps on it OPEN.
- Reference (RoomResponse REPL / `D:\repos\RoomResponse\`, vendored at
  `pianoid_middleware.modal_adapter.measurement.*`) is a FIRST-CLASS FLOW INPUT: Ring 1 must EXPRESS
  the exact procedure (excitation, timing, channel roles, calibration, repetitions, averaging) and
  make deviation visible → CP candidate. "Wired but not tested" is also a FLOW failure (fake gate) →
  Ring 1/Ring 3 must answer "how does the user KNOW a capture is good?" → CP/robustness candidate.

### PART 0 · Topic 2 — FLOW · Ring 1 (MVP happy path)  [IN DIALOG]
- USER-LED. Opened by putting a proposed MVP capture pipeline (physical instrument → project-ready
  measured data, minimal branching) to the operator as a numbered step sequence with per-step
  reasoning, for correction. Draft sent (below).

Proposed MVP (v1, sent to operator):
1. Enter on capture (not analysis) — fixes wrong-default-section; capture is the natural start with a
   physical instrument in hand.
2. Create/name the Measurement (capture-session container) — entity is sound; one Measurement = one
   physical setup session.
3. Define the setup ONCE as a single coherent surface (devices + channel roles + excitation/impulse +
   series/timing) — this is the "express the reference procedure exactly" surface; replaces the 5
   scattered accordions hidden behind the title-bar gear.
4. Validate with a Setup Test that is a REAL gate — one calibration cycle vs criteria; flow does not
   advance to real capture until pass (or explicit recorded override). Flow-level answer to "wired but
   not tested / how do I know it's good".
5. Capture scenario at excitation position #1 — record the repetition series, stream the log, produce
   the per-scenario averaged response; the flow KNOWS which position it is at (kills hardcoded-0).
6. Advance to the next position and capture the next scenario — repeat 5 per position; the multi-
   position loop is the heart of the procedure; scenario N is first-class.
7. Review the captured set — per-scenario QC (effective signal length etc.); see good/bad positions;
   re-capture bad ones. Second half of "how do I know it's good", at the set level.
8. Finalize → project-ready measured data (averaged across scenarios), handing off to the settled
   processing stage (create Project / ESPRIT).

**^ MVP v1 SUPERSEDED** after reading the RoomResponse reference (`D:\repos\RoomResponse`, dev @3b094272,
cloned READ-ONLY; migration doc `docs/proposals/archive/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md`). v1's
steps 3-4 wrongly collapsed a genuine multi-stage TUNE-AND-VALIDATE arc into "define once + one gate",
and step 8 wrongly said "average across scenarios". Corrected below.

### Reference procedure — DERIVED from RoomResponse (the known-good tool)

Real entry point is `piano_response.py` (RoomResponseGUI, hierarchical sidebar); `gui_launcher.py` is
orphaned. One shared `RoomResponseRecorder` mutated by every panel.

Recording unit hierarchy (grounded in `RoomResponseRecorder.take_record` + `DatasetCollector`):
- **cycle/pulse** = one impulse; a signal is a train of `num_pulses` identical cycles.
- **measurement** = ONE `take_record` call = one full pulse-train recording, already cycle-averaged in-line.
- **scenario** = `num_measurements` repeated measurements at ONE physical position. Cross-measurement
  averaging → `averaged_responses/average_chN.npy` is a DEFERRED post-step (`generate_missing_averages`;
  in Modal Adapter = `scenario_averager` at project-create time). ESPRIT consumes PER-scenario averaged
  responses. **There is NO "average across scenarios".**
- **series/dataset** = loop over scenario NUMBERS. Repositioning the actuator is a MANUAL bench action
  BETWEEN scenarios, cued by inter-scenario delays (~60s) + beeps. No programmatic actuator control, no
  in-UI "next position" confirm — the flow tracks the scenario NUMBER, the human moves the hardware.

Two MODES (`take_record(mode=...)`): **Standard** (simple cycle-average, onset on reference channel) vs
**Calibration** (per-cycle validate→align→normalize→average; needs multichannel + calibration_channel).
Shipped `recorderConfig.json` makes calibration the PRACTICAL default (voice_coil, 6-8ch, cal_ch set,
`normalize_by_calibration=true`) though the mode STRING defaults to 'standard' at code level. → This is
exactly the audit's DIVERGENT surface: if MA's live path runs Standard where the config intends
Calibration, calibration-normalization + robust alignment silently drop.

The reference tool's real ARC (from `piano_response.py` sidebar + panels):
CONFIGURE devices+channels+mode → CALIBRATE/learn per-cycle quality thresholds (Calibration Impulse
panel) → DESIGN pulse+series timing + TEST (Test Pulse = 1 pulse capture+overlay; Record Series =
throwaway full-train dry-run with analysis) → COLLECT real scenarios (Single or Series) → REVIEW
(Scenarios "Sanity Check" split-half reproducibility). All gating is ADVISORY; the ONLY hard stop is a
Calibration measurement yielding 0 valid cycles → aborts that scenario.

How the reference answers "is this capture trustworthy?" (much deeper than MA's Setup-Test): per-cycle
Valid✓/✗ vs 7 learnable criteria (+ threshold learning from marked-good cycles); alignment mean
correlation + aligned-cycle overlay; post-record valid-cycle %, peak-ratio ~1.0, cycle-consistency
overlay + range-width %; final split-half Sanity Check.

### MVP v2 (reference-grounded) — SENT to operator as a read-back

- **A. Configure the rig** — enter on capture in a Measurement session (one rig = one Measurement);
  set audio devices + channel roles (num channels, names, calibration/force channel, reference,
  response); choose the recording MODE (Standard vs Calibration) — made EXPLICIT because it selects the
  entire downstream processing path (validate/align/normalize vs simple average).
- **B. Design & tune the excitation** — design pulse (voice_coil/sine/square) + series timing + volume,
  with live preview; if Calibration, define/learn the per-cycle quality criteria.
- **C. Validate the setup (iterative, the real trust stage)** — Test Pulse (one pulse; actuator+sensor
  alive, clean impulse); then Record-Series dry-run (one throwaway full train; inspect valid %,
  alignment correlation, cycle-consistency, peak ratio). Iterate B/C until satisfied.
- **D. Capture the dataset (scenario loop)** — capture scenario N = num_measurements repeats at the
  current position, live per-measurement feedback; scenario NUMBER is first-class (kills hardcoded 0);
  a 0-valid-cycle calibration measurement hard-stops the scenario. Then reposition (manual) and capture
  the next scenario; repeat per position.
- **E. Review & finalize** — cross-MEASUREMENT averaging per scenario → averaged_responses, with the
  processing path/mode made EXPLICIT (no silent live-standard vs import-calibration mixing — the audit
  obligation); review set quality (Sanity Check / effective signal length), re-capture bad scenarios;
  hand off per-scenario averaged responses to the settled processing stage.

### CP candidates emerging from the flow (to derive AFTER flow settled)
- CPx "Express-the-reference": the flow must be able to express the reference procedure exactly and make
  any deviation from it visible. (traces Ring 1)
- CPx "Know-it's-good": at every commit point the user can tell whether the capture is trustworthy —
  Test Pulse, dry-run analysis, per-measurement validity, set-level reproducibility. (Ring 1/Ring 3)
- CPx "No-silent-path-mixing": it is impossible to be unaware WHICH processing path/mode produced a given
  averaged response, and impossible to silently mix them. (from the audit DIVERGENT finding; modules-level
  dependency on the audit verdict marked OPEN — do NOT assume outcome.)

### OPEN intent question sent to operator (Topic 2)
The reference keeps validate-before-capture ADVISORY (expert reads the analysis; only 0-valid-cycles
hard-stops). Given "wired but not tested / I'm not sure it's intact" + today's fake gate — does the
operator want the redesigned flow to (a) faithfully reproduce the advisory-expert workflow, or (b) turn
trust into an ENFORCED gate (a failed validation BLOCKS real capture)? Pure intent; code can't settle it;
shapes Ring 1's spine + the CP set (trust-as-visibility vs trust-as-guarantee).

### PART 0 · Topic 2 — FLOW · Ring 1  [LOCKED]
- Operator chose **(c) advisory now, gate later** → Decision D4. Read-back NOT corrected → accepted.
  Audit CONFIRMED hierarchy + calibration-default + advisory-loop-not-ported from source.
- Ring 1 locked as stages A–E (configure → design → validate-and-iterate(rebuilt) → capture-loop →
  review). The rebuilt advisory validation loop IS the substance of Ring 1 (never ported), not a preamble.
- Audit FINAL (D5): faithful EXCEPT recorder.py excitation DRIFT (WI1) + hardwired standard-mode (WI2);
  advisory loop + learnable criteria not ported (WI3); import-path scenario_averager = non-reference
  OUTLIER, reconcile toward reference naive-mean (WI4); naive live averaging REFUTED as defect. Excitation
  drift + hardwired mode are CAMPAIGN WORK ITEMS. Still UNVERIFIED (not assumed): downstream magnitude,
  production-project contamination, FE-loop status.

### PART 0 · Topics 3-8 — CPs → decision hierarchy → APs → architecture → classification → modules → cross-cutting  [DRAFTED into proposal]
- Derived from the locked flow (agent-led per coordinator). Written to the proposal:
  CP1..CP5 (dropped "faithful-layout"; folded learn/tune → CP1+CP2); decision hierarchy (CP1/CP3 correctness
  > CP4/CP5; CP1=substance governs CP4=presentation; CP2=visibility per D4); AP1..AP7; classification =
  recording-unit hierarchy + transition graph; modules survive/replaced/repaired/new (modal_adapter.py
  FROZEN; preset_injector mass_inv seam OUT OF SCOPE unless operator pulls in, flagged); cross-cutting
  (provenance, setup single-source, N4/N5, pause/resume); WI1-WI5; two traceability matrices.

### PART 0 · Topic — FLOW · Ring 2 (branches)  [IN DIALOG — user-led]
- Candidate branch set drafted (import-instead-of-capture FD5; add-scenarios; re-capture bad scenario;
  unlock+edit sealed N4; many-Projects-from-one-Measurement N5; the deferred enforced gate D4). None locked.
- Next operator question: which branches in scope + priority.

CONSOLIDATION rec (RECOMMEND only, no git mv without approval): this campaign = governing doc for
measurement-stage work; measurement-entity proposal = reference (implemented); modal-mass = boundary
(mass_inv seam out of scope here); facade-shim-removal = sequence independently.

_(further topics appended as they are settled)_
