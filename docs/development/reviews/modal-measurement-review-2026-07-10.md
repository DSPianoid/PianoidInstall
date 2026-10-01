# Modal Adapter / Modal-Measurement Subsystem — Analysis & Review

**Date:** 2026-07-10
**Mode:** READ-ONLY analysis (no source edits, no build, no stack start).
**Scope:** The Modal Adapter panel + its full measurement→analysis→apply pipeline across
PianoidTunner (frontend), PianoidCore/pianoid_middleware (backend), and the seam into the
CUDA synthesis engine.
**Author:** `/analyse` read-only pass (orchestrator-dispatched).
**Provenance note:** The dispatch brief originally asserted "ModalAdapter does not yet exist /
zero grep hits." That premise was **retracted by the coordinator mid-task and is false** — it
came from reading a still-running background grep's empty output file. This review is written
against measured reality: the Modal Adapter is a large, mature, actively-developed subsystem.
The one correct part of the original premise: `docs/proposals/modaladapter.md` **is** an
unfilled 611-byte template.

---

## 1. Executive Summary (10 lines)

1. The "Modal Adapter" is a **shipped, mature subsystem** — a dedicated Flask server (port 5001),
   a ~35-module backend package, a full React panel + hook layer, ~60 tests, and 5 doc pages.
2. Its job: turn **impulse-response measurements of a real piano soundboard** into synthesis
   presets, by extracting vibrational modes (ESPRIT), tracking them, computing coupling, and
   injecting the result into the live engine on port 5000.
3. The pipeline is end-to-end complete and works: capture/import → collection → ESPRIT →
   tracking → feedin → (FRF → modal-mass, newer) → QC → apply-to-preset.
4. Two entities: **Measurement** (raw captures + setup, auto-locks) and **Project** (analysis
   decisions branched from a Measurement) — a clean, deliberate split (Phase-1 refactor).
5. The god-object split (`modal_adapter.py` 5,649→1,755 LOC, −69%) **is DONE** (all 3 waves
   merged); the facade-shim-removal follow-up is **proposed but not started**.
6. Structural debt remains: `modal_adapter.py` and `project_store.py` are still RED (>1000 LOC),
   the frontend `ModalAdapter.jsx` + `useModalAdapter.js` are RED god-files, and 3 dialogs
   exceed 1000 LOC.
7. **Key data-model finding:** the engine's mode carries THREE tunable coefficients
   (`dec`, `omega`, `mass_inv`); the preset injector writes only frequency+decrement (→ dec,
   omega) plus deck/sound-channel coupling — it **never sets `mass_inv`** (JSON `"mass"`).
8. Measured **modal mass** IS now extracted (FRF + residue kernels, Phase-2 shipped) but is a
   **read-only analysis product** — it is NOT wired into the apply/injection seam.
9. Duplicated frontend state (channel roles, effective-signal-length QC, modal-mass summary) and
   several cross-layer leaks (components calling backend directly, MA layer reaching into 5000).
10. A new campaign proposal is viable but must not collide with the two live split proposals; its
    natural, unclaimed target is the **measured-mass → engine-amplitude seam** (see §5, §7).

---

## 2. The Pipeline as an Explicit Chain (with owning modules)

All backend modules are under `PianoidCore/pianoid_middleware/modal_adapter/`.

| # | Stage | What happens | Owning module(s) |
|---|-------|--------------|------------------|
| 0 | **Acquire / Import** | Record multi-channel impulse responses (voice-coil actuator + force + response mics/accelerometers) OR import an existing dataset (folder / zip). | `collection_engine.py` (`MeasurementSession`), `collection_routes.py`, `measurement/recorder.py` (RR port), `measurement_import.py`, `fs_routes.py` |
| 1 | **Measurement entity** | First-class entity: raw wav + `setup/{audio,impulse,series,mapping,calibration_criteria}.json`; auto-locks after first scenario (N4). | `measurement_entity.py`, `measurement_catalog.py`, `measurement_routes.py` |
| 2 | **Setup Test** | One calibration cycle validated against `calibration_criteria.json`; pass/warn/fail. | `setup_test_engine.py` |
| 3 | **Average** | Per-cycle align → normalize-by-calibration → mean → truncate w/ fadeout → `averaged_responses/average_ch*.npy`. | `scenario_averager.py`, `measurement/signal_processor.py` |
| 4 | **Project** | Analysis entity branched from a Measurement; freezes a setup snapshot (N5); holds band/tracking config + results. | `project_store.py`, `project_context.py` |
| 5 | **ESPRIT extraction** | Per scenario: band-split → Hankel → SVD → TLS shift-invariance poles → conjugate-pair → continuous-time → MAC band-merge. Output: frequencies, damping ζ, complex mode shapes, poles. Force channel is **excluded** from the Hankel. | `esprit_orchestrator.py`, `esprit_runner.py`, `esprit/band_processing.py`, `esprit/mode_tracking.py` |
| 6 | **Tracking** | Link per-scenario detections into `ModeChain`s (freq_mean, damping_mean, stability, per-scenario detections). Methods: nuclei_merge (default) / sliding_window / sequential (deprecated). | `tracking_orchestrator.py`, `esprit/mode_tracking.py` |
| 6b | **Chain editing** | Manual create/merge/split/delete + undo/redo over tracked chains. | `chain_editor.py` |
| 7 | **Feedin** | Per pitch, `|rfft(response)|` sampled at each mode frequency → per-pitch mode-coupling ("amplitude proxy", mixes response × input force). | `feedin_extractor.py` (via TrackingOrchestrator) |
| 7b | **FRF → Modal mass / Q** (newer, Phase-1/2 shipped) | `H(f)=Y/X` using the force channel; residue circle-fit / RFP; per-chain **relative** modal mass + Q. Read-only analysis product. | `frf_orchestrator.py`, `modal_mass_orchestrator.py`, `modal_mass/*`, `qc/*` |
| 8 | **QC** | Effective-signal-length (T_eff jackknife), coherence, log-decrement Q cross-check. | `qc/`, `apply_service.py` (T_eff rollup) |
| 9 | **Apply / inject** | Convert chains → preset: freq→`frequency`, ζ→`decrement`, feedin→`deck` [feedin,feedback], sound coeffs→`mode_sound_channels`; load/switch preset on the **port-5000** engine. | `preset_injector.py`, `apply_service.py` |
| 9b | **External export** | Same data → 5 fixed-name RoomResponse text files + `mode_amplitudes.csv` + `relative_modal_mass.txt`. | `external_export.py`, `report_generator.py` |

**Facade:** `modal_adapter.py` (`ModalAdapter`) composes 7 service modules over a shared
`ProjectContext`; `modal_adapter_server.py` runs single-threaded (`threaded=False`, required
because CuPy GPU ops deadlock off the main thread) and pauses port-5000 synthesis during ESPRIT.

---

## 3. The Panel — Current Functionality + Structural Problems

### 3.1 Functionality
Root: `PianoidTunner/src/modules/ModalAdapter.jsx` (mounted in `PianoidTuner.js` with
`url=5001, launcherUrl=3001`). A compact-toolbar panel with four pipeline sections
(**Collect / ESPRIT-Setup / Tracking / Apply**) and a context-sensitive settings drawer.

- **Collect subpanel** (`panels/CollectionSubpanel.jsx`): Measurement selector + 5-section setup
  editor (General/Audio/Impulse/Series/Calibration) + shared SetupTest (3 surfaces) +
  Unlock-with-warning + streaming collection log + Import + "New Project from this Measurement".
- **Project subpanel** (`panels/ProjectSubpanel.jsx`): parent-Measurement card, ESPRIT band
  config (`EspritConfig.jsx`), tracking config, QC panel, Apply config, Branch.
- **Analysis views**: `StabilizationDiagram.jsx`, `ModalResultsView.jsx`, `ModalMassFreqChart.jsx`,
  `GridHeatmapInset.jsx`, `MeasuredMatrix.jsx`, `MappingEditor.jsx`.
- **Hook layer**: `useModalAdapter.js` is the central store (~40 state atoms, ~35 endpoints),
  composing `useProjectCRUD`, `useChainMutations`, `useServerLifecycle`; plus `useMeasurementCatalog`,
  `useMeasurementSetup`, `useSetupTest`, `useCollectionStatus`, `useModalMass`, `useModalMassRun`,
  `useImportSession`.

### 3.2 Structural problems (reviewed against `docs/development/CODE_QUALITY.md` §C4)

**God-files (RED >1000 LOC).** Per CODE_QUALITY snapshot + live counts:
| File | Doc snapshot LOC | Live count (this pass) | Status |
|------|-----------------|------------------------|--------|
| `modal_adapter.py` (facade) | 1,755 | — | RED (−69%, but still RED; §C4.1 policy) |
| `project_store.py` | 1,754 | — | RED (expected per split §4.1; sub-split contingency) |
| `esprit/mode_tracking.py` | 1,215 | — | RED |
| `external_export.py` | 1,033 | — | RED |
| `collection_engine.py` | 1,014 | — | RED |
| `src/modules/ModalAdapter.jsx` | 1,077 | **2,219** | RED (live count 2× the snapshot) |
| `src/hooks/useModalAdapter.js` | 1,356 | **1,799** | RED (live count higher) |
| `src/components/StabilizationDiagram.jsx` | 2,231 | — | RED |
| `CreateProjectFromMeasurementDialog.jsx` | 1,130 | **1,130** | RED (bulk = round-history comments) |
| `ImportScenariosDialog.jsx` | — | **1,197** | RED (not in snapshot) |
| `MeasurementsManagementDialog.jsx` | — | **1,055** | RED (not in snapshot) |

The **ModalAdapter.jsx / useModalAdapter.js live counts materially exceed the doc snapshot**
(2,219 vs 1,077; 1,799 vs 1,356). Either the snapshot is stale or the counting differs — flagged
UNVERIFIED (§8) pending a `wc -l` reconciliation, but the direction (RED, growing) is firm. The
frontend never received a split equivalent to the backend's 3-wave effort.

**Duplicated / competing state (frontend):**
- **Channel roles owned twice** — `useModalAdapter` (`channelRoles/bridgeBoundary/pitchOffset`,
  persisted via `/modal/mapping`) vs `useMeasurementSetup` manifest (persisted via
  `/modal/measurements/<id>/mapping_config`). Two sources of truth for "which channel does what,"
  reconciled only at project create/branch.
- **Effective-signal-length QC fetched in 3 places** — `EspritConfig.jsx`'s private hook,
  `CreateProjectFromMeasurementDialog.jsx`'s direct call, and `useProjectCRUD.getEffectiveSignalLength`.
- **Modal-mass summary owned twice** — `useModalMass` and `useModalMassRun` both hold a `summary`
  and both POST `/modal/run_modal_mass`; the two can diverge.
- `serverRunning` mirrored between `useServerLifecycle` and `useModalAdapter` (can lag).

**Cross-layer leaks:**
- `MeasurementTimingPanel.jsx` calls **port-5000** `/calibration_params` directly (hardcoded URL,
  wrong server for a modal-adapter panel, no hook).
- `CreateProjectFromMeasurementDialog.jsx`, `ImportScenariosDialog.jsx`, `ProjectSubpanel.jsx`
  import `axios` and hit `/modal/...` directly, bypassing the hook layer.
- `EspritConfig.jsx` fetches a **relative** `/modal/projects` (no `url` prop) — depends on a
  dev-server proxy rather than the injected 5001 base used everywhere else.
- `useModalAdapter` + `useServerLifecycle` reach cross-server to 5000 (`apply_to_preset`,
  `pause/resume_synthesis`) — the modal-adapter layer reaching into the synthesis server.

**Grab-bag / oversized backend modules:** `project_store.py` (lifecycle + import + export + zip +
legacy migration — sub-split to Store/Importer/Exporter already named), `external_export.py`
(5-file writer + modal-mass writer — different inputs/semantics), `esprit/mode_tracking.py` (RED).

**Open bug (KNOWN_BUGS.md):** heatmap smoothing slider blurs horizontal borders but not vertical
borders in the Project-subpanel grid heatmap. Cosmetic; not pipeline-affecting.

---

## 4. Status of the Two Live Proposals + Collision Risk

| Proposal | Status | Detail |
|----------|--------|--------|
| `modal-adapter-split-2026-05-21.md` | **Implemented (all 3 waves merged), kept top-level** | `modal_adapter.py` 5,649→1,755 LOC (−69%). 7 service modules + `ProjectContext` extracted. Stays un-archived ONLY because the ~400-LOC thin-facade target is not met (deferred, below). |
| `modal-adapter-facade-shim-removal-2026-06-06.md` | **Proposed, NOT started** | Purely cosmetic LOC tail: rewrite ~300 external test refs `adapter._X → adapter._ctx.X`, delete 59 property shims. Realistic floor is ~1,000–1,200 LOC (not 400 — the ~80 REST delegations are the preserved API). Low conceptual risk, high edit volume. Also names an OPTIONAL `project_store.py` sub-split (Store/Importer/Exporter). |

**Collision risk for a new campaign proposal:**
- The **split** is done and the **facade-shim-removal** is a self-contained cosmetic wave. A new
  campaign that touches `modal_adapter.py` internals would collide with the pending shim rewrite —
  a new campaign should treat the facade as frozen and land its logic in a **service module**, per
  the §C4.1 thin-facade policy.
- The **modal-mass / Q-factor** proposal (`modal-mass-q-factor-2026-05-24-merged.md`, PARTIAL —
  Phase 0+1 shipped, Phase 2 mass kernels shipped, Phases 2e/3+ and staged sustained-excitation
  measurement types NOT built) is the closest neighbour. A new campaign about **measured-mass →
  engine amplitude** must coordinate with it (it owns the measurement side; the engine-injection
  side is unclaimed). This is a boundary, not a hard collision.
- The **new campaign's clean, unclaimed target** is the **apply/injection seam** (§5): wiring the
  already-measured `relative_modal_mass` into `preset_injector`'s per-mode `mass` and reconciling
  it with the deck/feedin amplitude path. No live proposal claims this.

---

## 5. The Seam — What a New "Modal Adapter → Engine" Work Would Fill

The transform from measured modal data to engine parameters **exists and is implemented** in
`preset_injector.py` (`PresetInjector.apply_with_feedin` / `build_preset_to_file`). It writes:
frequency→`preset['modes'][k]['frequency']`, ζ→`decrement` (`zeta_to_decrement`), per-pitch
feedin→`deck` (`[feedin, feedback]`, `np.stack`), sound coeffs→`mode_sound_channels`.

**The concrete gap:** the engine's mode carries a **third** tunable per-mode coefficient,
`mass_inv` (inverse effective mass; JSON key `"mass"`, `dev_mode_state` row 2), which is
**multiplied into the modal forcing term** and (per the docs) sets a mode's *absolute amplitude*
while the deck coefficient sets only its normalised (0–1) spatial *shape*. The injector **never
writes `mass`** — it leaves the baseline preset's value untouched. Meanwhile the subsystem now
**does measure** per-mode relative modal mass (FRF residue extraction, Phase-2 shipped) but keeps
it as a read-only analysis product (`relative_modal_mass.txt`, `ModalMassFreqChart`), never fed
back into the preset. So measured modal loudness balance is governed today entirely by the
feedin/deck coupling amplitude, not by the measured modal mass — even though both the engine
parameter and the measured quantity now exist. Closing that loop (measured `m_n` → engine
`mass_inv`, reconciled against the deck amplitude convention so the two do not double-count) is
the precise, unclaimed seam a new campaign would fill. It is a data-model-and-calibration problem
(units, relative-vs-absolute, double-normalisation), not a missing-plumbing problem.

---

## 6. Data-Model Facts (with doc citations)

Doc-supported unless tagged UNVERIFIED. Cited docs: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`,
`MODE_PHYSICS.md`, `docs/architecture/DATA_FLOWS.md` (§2.3/2.4/2.7),
`docs/modules/pianoid-basic/OVERVIEW.md`, `docs/guides/MODAL_ADAPTER_GUIDE.md`.

- **Mode coefficients (engine).** A mode = damped oscillator with 3 tunable coefficients stored
  mode-major in `dev_mode_state`: row0 `dec = 2γ dt`, row1 `omega = ω²dt²`, row2 `mass_inv = 1/m`
  (SYNTHESIS_ENGINE.md §Mode Simulation / §Discrete update; MODE_PHYSICS.md). Guide gives the
  conversions `dec = dt·decrement·frequency`, `omega = dt²·frequency²·4π²`
  (MODAL_ADAPTER_GUIDE.md §Preset Conversion). Units: dimensionless (audio-sample cadence);
  `mass_inv` = inverse effective mass (calibration convention, not strict SI).
- **Modal mass exists in the engine.** `Mode.mass_inv` (renamed 2026-04-30 from `Mode.mass`),
  preset JSON key stays `"mass"` but the *value is inverse-mass* (DATA_FLOWS.md §2.7 Save Flow;
  MODE_PHYSICS.md). Mode absolute amplitude = f(mass_inv) with deck = normalised shape only
  (pianoid-basic OVERVIEW §Coupling Coefficients).
- **deck.** Python `Pitch.deck = {feedin[num_modes], feedback[num_modes]}` per pitch; preset JSON
  `deck.shape=[2,num_modes]` (axis0 = {0:feedin,1:feedback}, axis1 = mode) matching the injector's
  `[feedin,feedback]` order (DATA_FLOWS.md §2.4/2.7). CUDA `dev_deck_parameters` is
  `num_strings × num_modes` row-major (`mode_coefficients[stringNo*numModes+modeIdx]`) — the
  "same name different thing" hazard is doc-called-out (DATA_FLOWS.md §2.4 disambiguation).
  Units: 0–1 normalised; raw FFT magnitudes (~1e-4) produce silence (SYNTHESIS_ENGINE §Coupling).
- **sound_channel vs string_sound_channel.** `mode_sound_channels`/`coefficients[pitch][num_channels]`
  active when `listen_to_modes=1`; `string_sound_channel`/`string_coefficients[pitch][num_channels]`
  is a per-output-pitch gain active when `listen_to_modes=0` — different stores, selected by the
  flag (DATA_FLOWS.md §2.4; pianoid-basic OVERVIEW §SoundChannels). **Stored-vs-effective:** both
  stored for pitches 0–139, but strings-mode consumes only output rows 128..127+num_output_channels
  (pianoid-cuda OVERVIEW §Stored vs effective). `string_sound_channel` REST kind is currently
  DORMANT (no frontend writers).
- **levels_matrix.** A PianoidBasic **excitation** construct, `(128, 4, 5)` =
  [velocity_level, param(0:mu,1:sigma,2:volume,3:shift), gauss_component] (pianoid-basic OVERVIEW
  §ExcitationParameters; DATA_FLOWS §2.2). **NOT part of the modal/deck seam** — excitation ≠ modes.
- **num_modes ceiling.** `num_modes` default 32, max 256; padded to `num_strings` at pack
  (dummy ID=−1). `num_modes ≤ num_strings` (modes ride string blocks) and
  `num_modes + num_sound_channels ≤ num_strings` — corroborated but **source-tagged** (see §8).

---

## 7. Open Questions (need operator decision before a proposal's foundations)

1. **What is the actual campaign target?** The operator's phrase "modal measurement functionality"
   maps to an already-shipped subsystem. Is the intended work: (a) close the measured-mass →
   engine-`mass_inv` seam (§5); (b) build the not-yet-built staged FRF/modal-mass measurement types
   (Phase 2e/3 of the modal-mass proposal); (c) a frontend structural cleanup (ModalAdapter.jsx /
   useModalAdapter.js split + de-dup state); or (d) fill the empty `modaladapter.md` as a
   consolidating overview? Each is a different proposal.
2. **Mass seam semantics:** if we inject measured `m_n`, is it **relative** (m_n/m_ref, the only
   thing currently measurable without a channel SI calibration) or do we require the user to supply
   `calibration_channel_si_per_count` for absolute kg? And how do we avoid **double-counting**
   amplitude between `mass_inv` and the deck/feedin coupling (which currently carries all amplitude)?
3. **Deck vs mass ownership of loudness:** the docs say deck = shape (0–1), mass = amplitude — but
   the injector today puts measured feedin (an amplitude proxy) into deck. Which quantity should own
   modal loudness after the seam lands? This is the central calibration decision.
4. **Facade freeze:** should a new campaign land strictly in service modules (per §C4.1), treating
   `modal_adapter.py` as frozen until the shim-removal wave runs — and should the shim-removal +
   `project_store.py` sub-split be sequenced BEFORE the campaign to avoid RED-file collisions?
5. **Frontend structural debt:** is a `useModalAdapter.js` / `ModalAdapter.jsx` split (mirroring the
   backend 3-wave effort) in scope, and is the duplicated channel-role / QC / modal-mass state to be
   consolidated as part of the campaign or tracked separately?
6. **Modal-mass proposal boundary:** the merged modal-mass/Q proposal is PARTIAL and owns the
   measurement side. Does the new campaign subsume its Phase-2e/3 items, or strictly consume its
   outputs at the engine seam?

---

## 8. UNVERIFIED Data-Model / Structural Facts (source-only or unreconciled)

- **`num_modes ≤ num_strings` and `num_modes + num_sound_channels ≤ num_strings`.** Corroborated by
  a middleware comment and the kernel index convention, but the authoritative source is a
  source-tagged dev context note (`string-mode-coupling-mode-scaling-context-2026-06-06.md`, cites
  `Kernels.cu:253`, `MainKernel.cu:667`), not a stable module doc. Treat as UNVERIFIED(source-only).
- **Packed deck row-width padding** to `num_strings` (`StringMap.py:440` mechanism) — source-tagged;
  the `num_strings × num_modes` logical shape IS doc-confirmed, the padding detail is not.
- **Frontend LOC discrepancy.** Live counts `ModalAdapter.jsx`≈2,219 and `useModalAdapter.js`≈1,799
  exceed the CODE_QUALITY snapshot (1,077 / 1,356). Needs a `wc -l` reconciliation to confirm which
  is current; the RED classification holds either way. UNVERIFIED(count).
- **Whether `apply_to_preset` ever writes `mass`.** Confirmed from `preset_injector.py` source that
  the three write paths do NOT set `mass`; not separately doc-stated. Source-verified, doc-absent —
  low risk but flagged so a proposal doesn't assume a doc backs it.
- **Feedin as "amplitude proxy mixing response × input force"** — stated in the modal-mass proposal
  (`§3.5`) from source reading of `feedin_extractor`, corroborated but not in a stable module doc.

---

## 9. Health Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| Documentation | Good | 5 dedicated pages + rich proposal history; MODAL_ADAPTER_GUIDE is thorough. Gap: no single "measured-mass → engine seam" doc; `modaladapter.md` empty. |
| Architecture (backend) | Fair→Good | 3-wave split landed; clean service/ProjectContext shape. Residual: 2 RED modules, facade still RED pending cosmetic wave. |
| Architecture (frontend) | Fair | No split equivalent; god-panel + god-hook, duplicated state, cross-layer leaks. |
| Code Quality | Fair | Multiple RED files (>1000 LOC) both layers; §C4.1 policy in place but debt visible. |
| Test Coverage | Good | ~60 backend tests across unit/integration/system; module-level tests added per split wave. |
| Seam completeness | Fair | Freq/damping/coupling injection complete; measured modal mass NOT wired to engine `mass_inv`. |

---

*End of review. READ-ONLY pass — no source edited, nothing built or committed. The proposal itself
(`docs/proposals/modaladapter.md`) is intentionally NOT authored here; that is a separate dispatch.*
