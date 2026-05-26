# Work in Progress

## Active Dev Sessions

| Agent | Task | Log | Started | Status |
|-------|------|-----|---------|--------|
| dev-cfl | Courant/CFL stability guard: derive+document CFL_LIMIT (von-Neumann), parameterKernel per-string ratio + R1 reject (shadow-coeff fallback), middleware REST per-string ratio extraction + 4xx on reject | [log](logs/dev-cfl-2026-05-24-092641.md) | 2026-05-24 | In Progress |
| dev-ratiochart | PianoidTunner CFL stability ratio-vs-pitch chart (ECharts pane, consumes `GET /get_parameter/stability_ratio/<key_no>`) — deferred companion to dev-cfl | [log](logs/dev-ratiochart-2026-05-24-184903.md) | 2026-05-24 | In Progress |
| dev-cfl-v2 | CFL guard v2 RE-IMPLEMENTATION per docs/proposals/cfl-stability-guard-v2.md — host-side closed-form pre-upload reject; removes v1 kernel sweep + shadow/flag buffers; backs stability_ratio host-side; keeps tests + REST contract | [log](logs/dev-cfl-v2-2026-05-26-121700.md) | 2026-05-26 | Done (Phase 1) — committed on feature/cfl-stability-guard-v2; fresh --heavy build verified, 27/27 tests, live pitch-57 SUSTAIN; NOT merged (awaits user final re-test) |

---

## Separate (UNCONFIRMED) bug — length / string_iteration edit crash is NOT coefficient-CFL (dev-cfl, 2026-05-25)

The user reported that editing "r [radius], length, string iterations, etc." can destabilise the engine.
Measured findings (dev-cfl, in-process):
- **radius**: CONFIRMED coefficient-CFL — `coeff_bending ∝ r⁴`, a large radius drives the FDTD amplification
  factor `max|g| > 1`. The CFL stability guard (θ-swept gate, this session) REJECTS it. Covered.
- **length / string_iteration**: these drive `coeff_tension, coeff_bending → 0` (larger dx / smaller dt),
  which lands at the **marginal `|g| = 1`** defective double root — *identical to a healthy lossless string
  (the baseline preset is also `|g| = 1`)*. This is NOT a coefficient-CFL instability and the CFL guard
  correctly does NOT (and must not) reject it (rejecting would refuse normal presets).
- **Therefore**: IF a length / string_iteration edit actually crashes, it is via a DIFFERENT mechanism —
  the dx-unit / grid-resolution / array-bounds family (cf. the #144 `length→dx` regression), NOT the FDTD
  CFL coefficient bound. **This crash is INFERRED from the user's report, NOT reproduced/measured by dev-cfl.**

**Status: UNCONFIRMED, separate task.** Not fixed in the CFL-guard session (out of scope — the CFL guard
cannot address it without rejecting healthy presets). To pin: reproduce a live length/string_iteration edit
and capture the actual failure signature (or get the user's exact length/iter repro). Owner: open.

---

## Deferred follow-up — CFL stability guard: UI plotting + dx-granular update quirk (dev-cfl, 2026-05-24)

**CFL stability guard is IMPLEMENTED + verified** (kernel R1 reject + shadow fallback + per-string flag,
host getters, middleware REST extraction + 4xx; 6 system tests pass; no synth regression). On
`feature/cfl-stability-guard` (PianoidCore), awaiting the user's test + approval before merge. Derivation +
bound in `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "FDTD Stability (CFL / Courant) Bound".

Two follow-ups, both **explicitly out of scope** for this task (flagged, not built):

1. **UI ratio-vs-pitch plot — IN PROGRESS (dev-ratiochart, 2026-05-24).** The per-string CFL ratio is
   extractable via `GET /get_parameter/stability_ratio/all`. User chose **option B**: surface the chart
   through the STANDARD chart mechanism (selectable like other charts), which required first extending the
   generic renderer (it could only draw a uniform line on an array-index x-axis — no pitch axis / threshold
   line / stable coloring). Split into two parts:
   - **Part 1 — DONE (frontend renderer enhancement).** On PianoidTunner branch `feature/cfl-stability-chart`.
     Extracted `newWindowChart.jsx` option-building into pure `src/utils/chartOption.js` `buildChartOption()`
     + added an OPT-IN `render_hints` channel (explicit x-axis, threshold markLine, per-point color+symbol,
     tooltip metadata). Every field optional → hint-less charts render byte-identical. Contract documented in
     `docs/modules/pianoid-middleware/CHART_SYSTEM.md` "Optional render_hints". Verified by
     `src/utils/__tests__/chartOption.test.js` (12 tests: 5 back-compat + 7 contract); full Jest 62/693 PASS,
     0 regressions. Committed on the feature branch, NOT merged (awaits user test + approval).
   - **Part 2 — PENDING, BLOCKED on CFL guard merge.** A `chartFunctions.py` `cfl_stability_ratio_function`
     + `chart_config.json` entry that reads the per-pitch ratio/flag (via dev-cfl's `getStringStabilityRatios()`
     / `getStringStableFlags()`) and emits the `render_hints` Part 1 consumes (pitch x-axis, threshold at
     `cfl_limit=1`, stable=teal/circle vs unstable=red/diamond, `{stable}` tooltip meta). **Why blocked:**
     (a) those getters live ONLY on the UNMERGED `feature/cfl-stability-guard`; (b) editing PianoidCore now
     collides with dev-cfl holding its working tree for the Phase 2 merge. Owner: dev-ratiochart; starts once
     the CFL guard is merged to PianoidCore `dev` (branch off the updated `dev`, getters present).

2. **`dx` granular update path returns false ("Failed to batch update dx").** While building a guard
   validation script, a direct granular `dx` edit via `update_pitch_physical_params_GRANULAR(pitch, dx=…)`
   logged `WARNING: Failed to batch update dx` (the GPU upload was dropped) — so a raw-`dx` granular edit
   may not reach the engine. The `tension` knob works fine (used for the guard tests), and the normal
   `length`→`dx` path is the supported route (raw `dx` is not a frontend-exposed editable). This is a
   pre-existing middleware quirk, NOT introduced by the guard, and did not block the task. Owner: open;
   investigate if a raw-`dx` granular edit is ever needed (likely an async DROP_IF_BUSY without a
   waitForParameterUpdate, or `dx` not surviving `set_param`).

---

## Deferred follow-up — Launcher-spawned backend dies ~30-60s after spawn (found dev-preset-bugs, 2026-05-23)

**Separate from the now-fixed ensureBackend mount-race.** A backend started via the launcher
(`POST /api/start-backend`) — or loaded via REST into it — dies as a **process** ~30-60s later,
with NO ensureBackend stale-kill (console: `:5000` socket.io "closed before connection
established"; PID confirmed gone). The launcher (`:3001`) stays alive. Originally observed during
dev-preset-bugs Step 10e earlier rounds.

**UPDATE (Step 10e round, 2026-05-23) — largely RESOLVED / re-characterised.** Starting the backend
via **PowerShell `Start-Process -WindowStyle Hidden`** (NOT the launcher API, NOT `Bash
run_in_background`) yields a backend that **survives >150s** (verified by a survival monitor) and
through a fresh-tab MOUNT (the Finding A mount-race fix's load-directly branch protects it). So the
"30-60s death" was the **launcher-API-spawn / `run_in_background` reaping path**, not an inherent
backend crash. The ONE remaining death mode is expected-by-design: a PowerShell-spawned backend is
NOT launcher-owned, so the frontend's `ensureBackend` orphan-cleanup **correctly kills it on a tab
RELOAD** once the launcher status resolves (`processRunning=false`). Mitigation for agent live work:
start via PowerShell `Start-Process`, drive in a FRESH tab (mount-protected), and do NOT reload that
tab; or accept the kill and restart. The user's normal `npm run dev` is unaffected (launcher owns its
backend). Owner: closed for practical purposes; reopen only if a launcher-owned backend dies. Detail
in the dev-preset-bugs Step 10e [log](logs/dev-preset-bugs-2026-05-23-184309.md).

---

## Deferred follow-up — Preset working-copy isolation (#1) ROOT-CAUSED + FIXED, awaiting user approval (dev-preset-bugs, 2026-05-23)

**#2 / #3 / #4 user-VERIFIED** and merged to PianoidTunner `dev` (`984434a`). **#1 (working-copy
isolation leak): ROOT CAUSE FOUND + FIX VERIFIED live (round 10e).** The persisting leak was a STRINGS
back-sync dependency-array bug: its speculative back-sync effect listed `parametersOfStrings` (+
`changeParametersOfStrings`, useCallback-bound to the same state), so it fired on the switch render
where `parametersOf*` is already NEW but `presetVersion` (and the re-init that arms `skipStringsSyncRef`)
has not bumped yet — re-POSTing the stale edit onto the new/spawned preset AND corrupting local
`parametersOfStrings` that the later re-init re-seeded from. Fix: fire the back-sync ONLY on a history
change (`[stringsHistory.values, stringsHistory.lastAppliedChange]`), matching modes/excitation which
never leaked. Measured live (differing values): spawn-from-original carried tension=5000 onto the new
working copy (backend slot + displayed field) before the fix; 650 (clean) after, on both. A real edit
still reaches the backend post-fix. Full Jest 61 suites / 681 tests green.

**State:** fix committed `908a6c5` on **`feature/preset-1-leak-trace`** (NOT merged); docs/log/
screenshot on root master `e3d2677`. Stack down. **Owner / next step:** the user does a fresh hard-
refreshed test of the spawn/switch repro on this branch; on approval, merge `feature/preset-1-leak-
trace` → PianoidTunner `dev` (NOTE: also carries the Finding A mount-race fix `06cf96b` + `0d31856`).
Earlier "in-flight WebSocket guard" hypothesis is SUPERSEDED — the round-2 `cancelPendingParamWrites`
was working correctly; the leak was the strings dep-array, not an in-flight WS write. Full diagnosis +
before/after in the session [log](logs/dev-preset-bugs-2026-05-23-184309.md).

---

## Live Measurement + Processing Flow — Wave 1 IN PROGRESS (live-processing-design, 2026-05-22)

**Status:** **Q1-Q12 locked by user** (Q1=C subprocess worker, overrides proposal-recommended
model D; all other Qs per proposal defaults). Wave 1 (plumbing + CuPy probe gate) implemented
by dev-liveproc-w1 — see session
[log](logs/dev-liveproc-w1-2026-05-22-144937.md). Tag: `[live-processing-design]`. Doc:
[`docs/proposals/live-processing-flow-2026-05-22.md`](../proposals/live-processing-flow-2026-05-22.md).

**Wave 1 deliverables landed:**
- NEW `live_processing_subprocess.py` (480 LOC) — persistent subprocess worker, IPC Job/Result
  dataclasses, CUPY_PROBE_OPERATION handler, parent-side supervisor with crash respawn
- NEW `live_processing_orchestrator.py` (241 LOC) — skeleton with state machine constants,
  `handle_scenario_done(measurement_id, scenario_number, scenario_subdir)` callback target,
  enabled-gate + state-transition + worker.start() ensure. Does NOT register on
  MeasurementSession yet (Wave 2 wires facade).
- `project_context.py` +5 fields + 2 locks + `record_live_processing_error()` helper +
  `LIVE_PROCESSING_ERRORS_MAX=50` constant
- `collection_engine.py` `MeasurementSession.__init__(on_scenario_done=None)` plumbed +
  guarded try/except invocation in `_run()` between `_finalize_outputs` and
  `_set_phase("resuming")` per proposal §Q3. Production constructors leave the param as
  None → ZERO runtime change (callback branch skipped). **C4 RED THRESHOLD CROSSED**
  (963 → 1014 LOC); recorded in CODE_QUALITY.md "Current Known God Objects" rank 16. Split
  deferred to modal_adapter-split Wave 3.
- 4 new test files under `tests/integration/modal_adapter/` (29 tests, all passing).
- **CuPy probe gate PASSES** — subprocess + CuPy round-trip verified (Q1=C foundation
  validated). Wave 2 dispatch unblocked.

**Wave 2 (NOT YET DISPATCHED):**
- Wire facade to register `LiveProcessingOrchestrator.handle_scenario_done` on
  MeasurementSession at construction time
- Add `submit_async` + parent-side result drain to SubprocessWorker
- Implement RUN_ESPRIT_OPERATION + RUN_TRACKING_OPERATION handlers in the worker
- Frontend toggle in CollectionSubpanel header + status chip + status panel in ProjectSubpanel
- Extend `/collect/status` payload with `live_processing` block

**Wave 3 (NOT YET DISPATCHED):** cancellation, retry, persistence, error UX polish.

**Scope.** Build a live "record-and-process" pipeline where the user has both a
Measurement and a Project open; each newly recorded scenario triggers
`EspritOrchestrator.run_esprit(scenario_indices=[N])` + `TrackingOrchestrator.run_tracking()`
on the recording thread (post-`_finalize_outputs`, pre-`_set_phase("resuming")`); user
sees the stab diagram + chain list update as they record.

**Architectural decisions surfaced (Q1..Q12).** Threading model (process-on-recording-thread
with CuPy probe gate; fallback to drain-on-Flask-main), concurrency safety (hybrid per-field
locks + rebind-and-grab for full replacements; explicit lock on `tracked_chains_version`),
trigger mechanism (in-process `on_scenario_done` callback on `MeasurementSession`), tracking
re-run cadence (per-scenario initially), FE update channel (extend existing `/collect/status`
polling — no SocketIO on port 5001), Project lifecycle (single Project; N5 frozen-snapshot
intact), cancellation semantics, failure handling (never blocks recording; surfaced via
status + retry button), data-model changes (5 new `ProjectContext` fields + 2 locks +
`live_processing` block in `project.json`), UX shape (toggle chip in CollectionSubpanel
header + status panel in ProjectSubpanel Setup), persistence, Wave-3 coordination.

**Estimated implementation scope.** ~3,200 LOC across three waves: Wave 1 plumbing + CuPy
probe gate (~1,000 LOC), Wave 2 happy path (~1,500 LOC), Wave 3 error handling + UX polish
(~700 LOC). Each wave is independently demoable.

**No blockers found.** N5 frozen-snapshot contract is compatible with live processing
(snapshot covers setup, not scenario data). Wave 2 orchestrators (shipped 2026-05-17) are
already structured to accept `scenario_indices=[N]` for incremental ESPRIT. CuPy
non-main-thread risk identified — mitigated via Wave-1 probe gate.

---

## Deferred doc-gap — CUDA build invocation under the Bash/MSYS layer (dev-reconcile, 2026-05-22)

**Owner:** next build-system / docs touch. **ETA:** next `/dev` session that edits BUILD_SYSTEM.md or `.claude/CLAUDE.md` build commands.

**Gap.** The canonical command in `docs/architecture/BUILD_SYSTEM.md` + `.claude/CLAUDE.md`
— `unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --release"` run
from the repo root — **fails under the Claude Code Bash tool's MSYS/Git-bash layer**. The
batch sets `REPO_ROOT=%~dp0` (its own dir), but MSYS rewrites the `cmd //c` path argument so
`%~dp0` loses the `PianoidCore\` component → `PROJECT_DIR=D:\repos\PianoidInstall\pianoid_cuda`
(missing `PianoidCore\`) → `[ERROR] Folder not found`, and it activates system Python instead
of the venv. Reproduced deterministically across repo-root-relative and absolute-path bash
invocations on 2026-05-22 (PianoidCore confirmed NOT a junction).

**Reliable invocation (works):** drive the batch through **PowerShell** (no MSYS path
translation), setting cwd to PianoidCore so `%~dp0` resolves correctly:

```powershell
$env:VIRTUAL_ENV = $null
& cmd.exe /c "cd /d D:\repos\PianoidInstall\PianoidCore && .\build_pianoid_cuda.bat --heavy --release"
```

**Resolution options for the next session:** (a) add this PowerShell form to BUILD_SYSTEM.md
as the "from the Claude Code Bash tool" invocation, OR (b) harden the batch to canonicalize
`REPO_ROOT` via `pushd "%~dp0"` so cwd-independent invocation is robust. Not fixed in this
session (reconciliation scope; build-system edit deferred to avoid widening this merge).

---

## ~~Round-26 heatmap smoothing contaminated white cells~~ — RESOLVED dev-maimport round 27 (2026-05-17)

**Status: RESOLVED.** Closed in dev-maimport round 27.
PianoidTunner commit `ffae98b` / merge `e03de8a`.

**The round-26 follow-up bug.** Round 26 replaced the bilinear NaN-
propagation overlay with a pairwise-border anti-aliasing algorithm that
should have left white cells untouched. User reported "the border
between two white cells gets colored when they are next to two colored
cells". Two compounded faults:

1. **Geometry source wrong (CRITICAL).** Round 26 used
   `instance.convertToPixel({xAxisIndex:0, yAxisIndex:0}, [0,0])` and
   `[nCols, nRows]` to derive the plot rect. On an ECharts category
   axis, `convertToPixel({xAxisIndex:0}, [0])` returns the CENTER of
   category 0 (the tick), NOT the LEFT edge of cell 0. The resulting
   plotRect was off by half a cell on every side; the canvas's
   internal cellW was wrong by 1/N; every painted stripe landed in a
   visually-wrong cell — including bleeding into white cells.
2. **1-pixel bleed from floor/ceil rounding (SECONDARY).** Round 26's
   `Math.floor(r*cellH)` for row r's top and `Math.ceil((r+1)*cellH)`
   for row r's bottom let row r's stripe extend 1 pixel into row r+1
   when cellH was fractional. That 1-pixel-tall bleed sat at the
   X-range of the stripe — also where two adjacent white cells in
   row r+1 met. User saw a thin colored line at the top of row r+1.

**The fix (round 27, frontend-only).** Three changes:

- **Change A (CRITICAL):** switch `EChartsWithOverlay.computePlotRect`
  to `instance.getModel().getComponent('grid', 0).coordinateSystem.getRect()`.
  Returns the true plot bbox `{x, y, width, height}` directly, no
  category-axis semantics. `convertToPixel` kept as fallback only if
  `getRect` is unreachable (defensive — stable API since ECharts 3.x).
- **Change B (DEFENSIVE):** `computeBorderPaintOps` uses `Math.round`
  consistently for cell edges (precomputed `rowEdges` / `colEdges`
  arrays — adjacent cells share the same integer pixel) and zone
  bounds (border position snapped to nearest integer, zone half-width
  rounded on both sides).
- **Change C (CONTAINMENT):** each op is clipped to the two-cell pair's
  combined bounds via the precomputed `colEdges` / `rowEdges`. At
  smoothing=2 this is a no-op under the current slider range (0..2)
  but codifies "an op CANNOT paint outside the two-cell pair area"
  as a hard invariant for future slider expansions.

**Hypothesis verification.** Temporarily reverted `GridHeatmapInset.jsx`
to round-26 via `git stash` and ran the round-27 test suite against
the buggy code: 3 tests failed (`adjacent rows' stripes meet at the
same y at fractional cellH`, `adjacent columns' stripes meet at the
same x at fractional cellW`, `prefers getRect() over convertToPixel`).
After `git stash pop`, all 38 GridHeatmapInset tests passed. Confirms
both Change A and Change B were necessary.

Test count delta: +12 round-27 tests (5 no-bleed + 5 white-cell
intrusion + 2 prefer-getRect). Full frontend suite 54/660. Zero
regressions.

---

## ~~Heatmap smoothing mutated the matrix server-side~~ — RESOLVED dev-maimport round 24 (2026-05-17)

**Status: RESOLVED.** Closed in dev-maimport round 24.
PianoidCore commit `93afae4` / merge `9b6a7dd`.
PianoidTunner commit `2808ed3` / merge `42f4be5`.

**The bug.** `GET /modal/grid_heatmap/<chain_id>?smoothing=N` ran
`scipy.ndimage.gaussian_filter` server-side on the per-cell amplitudes
and returned the SMOOTHED value in `cells[i].amplitude`. The frontend
heatmap tooltip showed those smoothed numbers as if they were
measurements ("amplitude: 4.123e-02") at any non-zero slider value.
The user's contract — "the underlying matrix must stay inviolate;
smoothing is a RENDERING concern" — was silently violated.

The companion `approximation="planar"` parameter had the same shape
of bug (fills empty cells via `np.linalg.lstsq` planar fit, returns
extrapolated values in originally-empty cells without flagging them
as fabricated to the consumer beyond the `is_measured` boolean).

**The fix (round 24).** Backend `VisualizationService.get_grid_heatmap_data`:
- DELETE the Pass-3 gaussian smoothing block (was `visualization_service.py:301-319`).
- DELETE the Pass-2 planar approximation block (was `visualization_service.py:284-299`).
- ACCEPT `smoothing` and `approximation` query params for URL-compat
  but silently ignore them. Echo fields always report `0.0` / `"none"`.
- Per-cell `amplitude` is now byte-identical to the raw scenario
  detection amplitude regardless of any params. Empty cells stay null.

Frontend `GridHeatmapInset.jsx`:
- New `SmoothingOverlay` sub-component — sibling `<canvas>` absolutely
  positioned over the ECharts heatmap plot area. Paints a bilinearly-
  interpolated image of the cell colors using the SAME visualMap
  palette ECharts uses. NaN propagation: any source cell null →
  pixel transparent (empty cells stay white). Pointer-events disabled
  so ECharts owns the tooltip surface — tooltip continues to show the
  TRUE measured amplitude.
- `useEffect` no longer depends on `smoothing` / `approximation`; slider
  drags repaint the overlay canvas without a backend round-trip.
- `useModalAdapter.getGridHeatmap` no longer forwards either param.

Slider in `StabilizationDiagram.jsx` relabelled "Smooth σ" → "Visual
smoothing" (range 0..2 preserved).

**Round-24 invariants (tested):**
- backend `cells[i].amplitude` unchanged across `smoothing ∈ {0, 2, 10, 100}`
- backend `cells[i].amplitude` unchanged across `approximation ∈ {"none","linear","planar"}`
- empty cells stay `null` regardless of param combination
- frontend hook calls axios.get with chainId only — no params
- frontend slider drags do NOT trigger refetch
- overlay canvas exists in the DOM with `pointer-events: none`

Test count delta: backend +8 round-24 tests (TestGridHeatmapApproximationAndSmoothing
class restructured — same 9-test footprint but every assertion inverted
to enforce the new no-op contract). Frontend +6 new hook-level tests
(`useModalAdapter.getGridHeatmap.test.jsx`) + 4 inverted existing tests
in `GridHeatmapInset.test.jsx` + 1 new overlay-canvas test.

---

## ~~Round-15 validation-rejection blocker — 87 of 92 user scenarios rejected at averaging~~ — RESOLVED dev-maimport round 18 (2026-05-21)

**Status: RESOLVED.** Closed in dev-maimport round 18.
PianoidCore commit `070d836` / merge `3c07c8b`.

**The blocker.** User's `PlyWoodLGtemp1` Measurement contains 92
scenarios; 87 use raw_recordings whose ``calibration_quality_config``
uses an older schema (``double_hit_*``, ``backfront_*`` fields) that
the in-tree V3 ``CalibrationValidatorV2.from_config`` doesn't
recognize. ``from_config`` silently falls back to V3 defaults — and
the user's narrow-spike calibration pulses violate those defaults
on multiple criteria (peak width < 0.3 ms, first-positive ratio
> 0.3, precursor ratio > 0.2). Result: 100% per-cycle rejection at
the averaging stage → ``STATUS_ERROR`` "All cycles failed
validation/alignment" for 87 of 92 scenarios. Only 5 with pre-
existing ``averaged_responses/`` survived (idempotency-skipped).

User read this as "create project doesn't work" — the dialog
succeeded with HTTP 201 but produced a project that loaded only 5
scenarios out of 92.

**Fix.** Removed per-cycle validation from
``scenario_averager.ensure_averaged_responses`` entirely (the
project-creation averaging path). Validation now runs at the
RECORDING stage only (``collection_engine`` /
``measurement_session``). Extends the principle round 7 locked in
for the analysis-stage QC path (``pool_scenario_cycles``) to the
recording-stage averager too. The user's locked principle:

> "Validation should be applied at the recording stage ONLY. Should
> not be reapplied to the imported measurements. Only averaging
> quality check."

**Code change** (commit `070d836`):
* Removed ``CalibrationValidatorV2`` + ``QualityThresholds`` imports
  from ``ensure_averaged_responses``
* Removed ``calibration_quality_config`` config fetch
* Removed ``validator = CalibrationValidatorV2(...)`` instantiation
* Replaced per-cycle ``validate_cycle`` loop with synthesized
  all-valid ``validation_results`` (identical shape to round 7's
  pool_scenario_cycles synthesis)

**Live verification** on user's PlyWoodLGtemp1 (private backend on
port 5500): POST `/modal/projects` → HTTP 201 in 414s. Results:
  - `computed: 91` (vs round-17 pre-fix: 0)
  - `errors: 0` (vs 91)
  - `skipped_existing: 1` (preserves idempotency)
  - `qc_computed: 91` (vs 0; QC now runs on every scenario)
  - `num_scenarios: 92` loaded (vs 5)
  - `scenario_loading_gap.excluded: []` (vs 87 entries)

**Tests.** +3 in `tests/integration/test_scenario_averager.py`
(`TestRound18NoValidationInAveraging`). 1 inverted in
`test_measurement_import.py` (`test_recording_stage_averager_*`
flipped to assert the validator is NOT called). 374/375 backend
tests pass — only failure is the pre-existing dev-0239 mock
signature issue.

---

## modal_adapter.py split — Wave 1 LANDED 2026-05-21

**Status: Wave 1 SHIPPED.** Per `docs/proposals/modal-adapter-split-2026-05-21.md`.

Wave 1 extracted `ProjectContext` + `ScenarioLoader` + `VisualizationService`
from the 5,649-LOC `modal_adapter.py` god-object. Result: 4,782 LOC
(-867 / -15%) in one PR. 23 facade methods replaced with 1-line
delegations; 25 instance-state fields moved to `ProjectContext` (with
backward-compat property shims on the facade for legacy `self._foo`
access). REST surface + tests unchanged.

PianoidCore commit `71ddf22` / merge `f591603`.
PianoidInstall doc commit (CODE_QUALITY.md §C4.1 facade policy +
proposal implementation log row): see this commit.

Wave 2 (EspritOrchestrator + TrackingOrchestrator + ApplyService) +
Wave 3 (ProjectStore + ChainEditor + facade rewrite) follow. **User
will live-test Wave 1 before Wave 2 dispatches.**

---

## ~~Round-9 deferred defect — `run_esprit` ignores `esprit/config.json`~~ — RESOLVED dev-maimport round 16 (2026-05-21)

**Status: RESOLVED.** Closed in dev-maimport round 16 (commit on
`feature/dev-maimport-import` → merged to PianoidCore `dev`; see commit SHA
in the round-16 transcript / merge log).

**The defect (round-9 finding, S-5 in the round-15 code review).**
`POST /modal/run_esprit` with an empty body — or with only `scenario_indices`
and no `bands` key — silently ignored the saved `esprit/config.json` and
fell back to `EspritRunner`'s hardcoded `extended_8band` defaults. A user
who saved a custom band_config via `POST /modal/esprit_config` and then
re-ran ESPRIT without re-sending the bands got the wrong analysis with no
warning. The docstring of `get_esprit_config` had already declared
`esprit/config.json` the single source of truth (round 8) but
`_run_esprit_sync` never read it. Frontend masked the bug because the
React form always re-sent the bands; REST API consumers + the proposed
Wave 2 `EspritOrchestrator` would have hit it.

**Fix.** Single-block insertion in
`pianoid_middleware/modal_adapter/modal_adapter.py::_run_esprit_sync`
(around line 3631). When `esprit_params` is empty or missing the `bands`
key, the function calls `self.get_esprit_config()` and merges the saved
dict into `esprit_params` with **caller fields winning over disk fields**.
Merge order:
- Empty body `{}` → saved config used verbatim
- Body with explicit `bands` → body wins (no fallback)
- Body with only `scenario_indices` etc. → saved bands + body's other fields

**Tests.** 6 new tests in `tests/integration/test_esprit_config_sot.py`
(`TestEspritConfigSotFallback`):
- `test_run_esprit_loads_from_disk_when_body_empty`
- `test_run_esprit_body_overrides_disk_config`
- `test_run_esprit_body_partial_merges_with_disk_defaults`
- `test_run_esprit_no_disk_config_no_body_passes_empty_to_runner`
- `test_run_esprit_scenario_indices_only_body_still_loads_disk_bands`
- `test_run_esprit_with_no_project_open_no_fallback`

203 backend tests pass across the related suites (was 197 → +6). Zero
regressions.

**Why this had to ship before Wave 1 of the modal_adapter split**
(per `docs/proposals/modal-adapter-split-2026-05-21.md` §10 risk #3 /
OQ4=before-Wave-1): fixing the SoT gap during Wave 2's
`EspritOrchestrator` extraction would entangle the bug fix with the
refactor — bisection becomes harder if the fix introduces a regression.
Shipping as standalone round 16 keeps Wave 2 a pure mechanical move.

---

## ~~Discovered defect — v2 Project scenarios not auto-loaded from parent Measurement~~ — RESOLVED dev-maimport round 4 (2026-05-19)

**Status: RESOLVED.** Closed in dev-maimport round 4
([commit on `feature/dev-maimport-import` → merged to PianoidCore `dev`]).
See [`logs/dev-maimport-2026-05-19-135147.md`](logs/dev-maimport-2026-05-19-135147.md)
§ Phase 1 RE-OPENED round 4 for the full implementation summary.

**Fix.** Added `ModalAdapter._load_v2_scenarios_from_parent_measurement()`
helper + an else-branch in `open_project()` that fires when the
project's `measurements/` directory yields zero scenarios AND
`project.json` carries `measurement_id`. The helper resolves the
parent's `scenarios/` directory (preferring `measurement_path` from
the project meta, falling back to `$PIANOID_MEASUREMENTS_DIR/<id>/scenarios`)
and loads via the existing `_discover_roomresponse_scenarios` helper.
When the parent is unreachable (drive unplugged / deleted), the
fallback emits a warning log and leaves `_measurements` empty —
downstream pipeline actions then surface the same recoverable
"No measurements loaded" 409 the user already knows.

**Both affected flows fixed:**
- "+ New Project from this Measurement" button (dev-maimport round 3)
- "Branch from this Project" button (dev-msmtui-fc) — same
  `create_project_from_measurement` codepath; the fallback fires
  for branched projects too (verified by
  `test_branch_project_also_loads_scenarios_via_v2_fallback`).

**Tests added (round 4, 5 new in `tests/integration/test_measurement_import.py::TestV2OpenProjectScenarioLoading`):**
- `test_open_v2_project_loads_scenarios_from_parent_measurement`
- `test_run_esprit_on_v2_project_succeeds_without_add_measurements`
- `test_open_v2_project_with_missing_parent_leaves_measurements_empty`
- `test_open_v2_project_idempotent_when_project_tree_has_scenarios`
- `test_branch_project_also_loads_scenarios_via_v2_fallback`

**Live verification (round 4):** end-to-end on real
`D:\modal_measurements\PlyWoodTake1_7` (30 scenarios / 8 channels):
fresh Measurement import → `POST /modal/projects` (v2) → 201 →
`POST /modal/projects/open` → 200 → `POST /modal/run_esprit` (NO
add_measurements call) → **HTTP 200 `{"message":"Complete","state":"done"}`**.
ESPRIT result: 30 scenarios processed, 146 modes in first scenario,
4,178 modes top-level merged, 4,237 raw modes summed across all
scenarios — identical numbers to the round-3 manual-workaround run.

**Original report follows for context.**

**Symptom.** A fresh v2 Project created via `POST /modal/projects` (the
endpoint behind the new "+ New Project from this Measurement" button)
opens with an empty in-memory `_measurements` dict. Running ESPRIT on
that just-opened Project returns `409 {"error": "No measurements loaded"}`
because `ModalAdapter.open_project` only walks
`<project>/measurements/scenario_*.npy` — it does not fall back to the
parent Measurement's `scenarios/<scenario>/averaged_responses/average_ch*.npy`
when `<project>/measurements/` is empty (which is the steady state for
v2 Projects, since v2 deliberately does NOT duplicate scenario data
into the project tree).

**Scope.** Pre-existing — affects both:
- the new "+ New Project from this Measurement" flow (dev-maimport)
- the existing "Branch from this Project" flow (dev-msmtui-fc) — same
  `create_project_from_measurement` codepath

NOT introduced by dev-maimport — confirmed by inspecting `branch_project`
(`modal_adapter.py:1579`) which already had this shape.

**Discovery:** dev-maimport round 3 live test
([log](logs/dev-maimport-2026-05-19-135147.md) § Step 7 round 3).

---

## Phase 2b Modal Adapter Frontend Collection UX (dev-msmtui-fe, 2026-05-11) — CLOSED, Gate 3 APPROVED

**Status:** Phase 2b of the Modal Adapter Measurement-entity refactor
([proposal](proposals/modal-adapter-measurement-entity-2026-05-10.md))
landed on PianoidTunner `dev` at 2026-05-11 and was **approved at Gate 3
by the orchestrator on 2026-05-11**:

- PianoidTunner feature SHA: `9aa9403`
- PianoidTunner merge SHA: `5c43447`
- PianoidInstall docs SHA: `f56f765` (+ session-log addendum `ff51f97`)
- Branch `feature/dev-msmtui-fe-phase2b-frontend-collection` retained on
  PianoidTunner for reference.

What landed:

1. **`<CollectionSubpanel>` replaces legacy `<CollectPanel>`.** New
   `modules/panels/CollectionSubpanel.jsx` orchestrator + 5 collapsible
   Accordion sections under `modules/panels/collection/`: General /
   Audio Devices / Impulse / Series / Calibration Quality Criteria.
   Each section: per-section Save Settings button + lock-aware UI
   (423 surfaced as "unlock to edit"). Calibration Quality Criteria is
   lock-exempt per N4 (analysis-time gate).
2. **Shared `<SetupTestPanel>` in 3 surfaces (Q4/Q5).** ONE component
   used in Audio Devices section + Impulse section + pre-flight
   `<SetupTestBanner>` (compact mode). Single `useSetupTest` hook
   instance owns the report state at the subpanel level so a Run from
   any surface updates all 3 displays simultaneously.
3. **Unlock-with-warning UI (N4 + N5).** `<UnlockMeasurementDialog>`
   with verbatim N4/N5 copy, persistent header button when
   `acquisition_locked === true`. POST `/modal/measurements/<id>/unlock`
   `{confirm: true}`.
4. **C4 split of `useModalAdapter.js` (2348 → 1742 LOC, −606).**
   Extracted 5 cohesive sub-modules into `hooks/modalAdapter/`:
   `constants.js` (53), `bandHelpers.js` (142), `useChainMutations.js`
   (123), `useServerLifecycle.js` (101), `useProjectCRUD.js` (342).
   Pure-helper re-exports preserved for back-compat (EspritConfig + 53
   useModalAdapter tests + 14 ChainEditor/ModalAdapter tests unchanged
   + green).
5. **3 new measurement-scoped hooks.** `useMeasurementCatalog` (list /
   create / delete via GET/POST/DELETE `/modal/measurements`),
   `useMeasurementSetup` (read manifest + PATCH each setup section,
   423-aware), `useSetupTest` (POST/GET `/setup_test`).
6. **Legacy retirement.** `components/CollectPanel.jsx` DELETED (was
   427 LOC). `hooks/useMeasurementCollection.js` rewritten as throwing
   410-Gone deprecation stub + smoke test.
7. **Tests.** 43 new Phase 2b tests across 7 suites, all green.
   PianoidTunner total: 389 passing across 35 suites; 0 regressions.
8. **Docs.** `docs/guides/MODAL_ADAPTER_GUIDE.md` gained a new
   "Collection Subpanel (Phase 2b)" section. Proposal annotated with
   Phase 2a/2b/2c split note + per-deliverable DONE markers in the
   Phase 2 detail section.

Phase 2c (per-Measurement `/collect/*` backend endpoints, per-Measurement
device enumeration, Project subpanel slim-down + branching, `<CollectionLog>`
streaming-log, `/copy` + `/create_from_zip` 410-Gone cutover, deeper
`ModalAdapter.jsx` panel-extracts) is unblocked.

See [`dev-msmtui-fe-2026-05-11-183353.md`](logs/archive/dev-msmtui-fe-2026-05-11-183353.md)
for the per-step session log (archived at close-out).

---

## Phase 2a Modal Adapter Backend Cutover (dev-msmtui, 2026-05-11) — CLOSED

**Status:** Phase 2a of the Modal Adapter Measurement-entity refactor
([proposal](proposals/modal-adapter-measurement-entity-2026-05-10.md))
landed on PianoidCore `dev` at 2026-05-11. Awaiting Gate 3 sign-off
which requires Phase 2b (frontend Collection UX) to also land.

- PianoidCore feature SHA: `925b1c8`
- PianoidCore merge SHA: `0176b7e`
- Branch `feature/dev-msmtui-phase2a-backend-cutover` retained.

What landed:

1. **Setup Test wired end-to-end.** New module
   `pianoid_middleware/modal_adapter/setup_test_engine.py` (~840 LOC).
   Replaces Phase 1 stub. `POST /modal/measurements/<id>/setup_test`
   now pauses synth -> captures one calibration cycle via
   `RoomResponseRecorder.take_record(mode='calibration')` ->
   evaluates per-criterion -> reduces overall (pass/warn/fail) ->
   resumes synth -> writes `setup_test/latest.{json,wav}` (N3).
2. **v1 `/modal/collect/*` hard cutover to HTTP 410 Gone (N8).** Six
   endpoints retired (start, status, cancel, results, devices, health).
   New `GET /modal/measurements/active_session` is the single legacy
   survivor per proposal sec 3.4.
3. **Streaming progress messages (Q8).** `MeasurementSession` gains
   a 100-entry ring buffer of `{ts, level, src, msg}` entries +
   `emit_message()` API + `measurement_id` field. Surfaced via the
   active_session probe.
4. **Tests.** 33 new integration tests across `test_setup_test_engine.py`
   (NEW, 20), `test_v1_collect_410.py` (NEW, 8), expanded
   `test_measurement_routes.py::TestSetupTest` (+4 cases),
   `test_modal_collection_b1.py` (+2 streaming tests). Full
   Phase 1+2a surface: 175 passed, 1 skipped.
5. **Docs.** `docs/modules/pianoid-middleware/MODAL_COLLECTION.md`
   marks v1 surface RETIRED + documents Setup Test/streaming flow.
   Proposal annotated with Phase 2a/2b/2c split note.

Phase 2b (frontend Collection UX) is unblocked. The user-visible
Gate 3 commit will land after Phase 2b ships the 5-section subpanel,
shared `<SetupTest>` component, and Unlock-with-warning UI.

See [`dev-msmtui-2026-05-11-143943.md`](logs/archive/dev-msmtui-2026-05-11-143943.md)
for the per-step session log (archived at close-out).

---

## Phase 0 RR-port (dev-rrport, 2026-05-10) — CLOSED, Gate 1 APPROVED

**Status:** Phase 0 of the Modal Adapter Measurement-entity refactor
([proposal](proposals/modal-adapter-measurement-entity-2026-05-10.md))
landed on PianoidCore `dev` at 2026-05-10 / 2026-05-11 and was
**approved at Gate 1 by the orchestrator on 2026-05-11**:

- PianoidCore feature SHA: `4c30f68`
- PianoidCore merge SHA: `47f57dc`
- PianoidInstall docs SHA: `93e48fd`
- Branch `feature/dev-rrport-phase0-rrport` retained on PianoidCore for
  reference.

What landed: 7 RR Python modules vendored under
`pianoid_middleware/modal_adapter/measurement/`, sdl_audio_core source
tree moved into `PianoidCore/sdl_audio_core/` and wired into
`build_pianoid_cuda.bat`, `_room_response_bootstrap.py` shim deleted,
`recorderConfig.json` vendored as `default_recorderConfig.json`. Build
verified end-to-end. 7 new sanity tests + all pre-existing modal_collection
/ scenario_averager / qc_curves / modal_create_from_zip tests pass.

Phase 1 (Data Model + REST) is unblocked.

See [`dev-rrport-2026-05-10-232416.md`](logs/archive/dev-rrport-2026-05-10-232416.md)
for the per-issue decisions and full session log.

---

## build_pianoid_cuda.bat — bash invocation breaks `%~dp0` (dev-midi-p2, 2026-05-11)

**Symptom.** Calling
`cmd //c "PianoidCore\\build_pianoid_cuda.bat --light --release"` from Git Bash
(the standard CLAUDE.md `--heavy`/`--light` invocation pattern) makes the
script's `%~dp0` resolve to `D:\repos\PianoidInstall\` instead of
`D:\repos\PianoidInstall\PianoidCore\`. As a result `PROJECT_DIR =
%REPO_ROOT%pianoid_cuda` becomes `D:\repos\PianoidInstall\pianoid_cuda`
(no `PianoidCore\`) and the script aborts at "[ERROR] Folder not found:
D:\repos\PianoidInstall\pianoid_cuda". A minimal replica bat in the same
directory (test_dp0.bat with `setlocal EnableExtensions EnableDelayedExpansion`
+ `%~dp0` echo) resolves correctly under the same invocation — so the
trigger appears to be something specific to build_pianoid_cuda.bat
(arg-parsing loop, venv activate.bat side-effect, or its early
operations) clobbering the script-relative path before line 53.

**Workaround.** Invoke from PowerShell with PianoidCore as cwd:
```powershell
$env:VIRTUAL_ENV = $null
Set-Location D:\repos\PianoidInstall\PianoidCore
cmd /c ".\build_pianoid_cuda.bat --light --release"
```
This produced the expected behaviour every time (REPO_ROOT correct, venv
python picked up, build succeeded). Same bat, same args — only the
invoking shell differs.

**Why it matters.** CLAUDE.md "Build Commands (Quick Reference)" instructs
dev agents to use `unset VIRTUAL_ENV && cmd //c "PianoidCore\\build_pianoid_cuda.bat --heavy --release"` on Windows. Every agent following that instruction
from Bash hits this and burns ~10 minutes diagnosing before falling back to
PowerShell. Worth either:
  (a) Add a "if `%~dp0` looks wrong, abort with diagnostic" guard at the top
      of build_pianoid_cuda.bat.
  (b) Update CLAUDE.md to recommend the PowerShell invocation for Bash-driven
      dev agents (or both).

**Owner / ETA.** Not allocated. Filed as a doc/infra deferral by dev-midi-p2
during Phase 2 work.

---

## `test_sound_output_quality` slow `soundTone` autocorrelation (dev-midi-p4, 2026-05-16)

**Observation.** `tests/system/test_performance_audio_off.py::TestSoundOutputQuality::test_sound_output_quality` can exceed the pytest per-test timeout on a busy machine. The hang is in `pianoid_middleware/SoundFeatures.py:soundTone()` — it runs a `while` loop calling `pandas.Series.autocorr(i)` (each call O(n) over the full series) for up to `len(sound)/2` lags, i.e. O(n²) over the ~144k-sample C4 render.

**Not a regression.** The render is deterministic; the test passes when the CPU is idle and times out when many processes compete (observed during W5/Phase-4 validation, with several GPU test processes + MCP servers running). dev-midi-p4 verified `TestSoundRegression`, `TestGpuCycleTiming`, `TestTimingDistribution` all pass — only `test_sound_output_quality` is affected.

**Suggested fix (deferred — out of W5/Phase-4 scope, `SoundFeatures.py` is not a MIDI file).** Replace the per-lag `pandas.autocorr` loop with a single vectorised autocorrelation (`numpy.correlate` / FFT-based `scipy.signal.correlate`), then pick the period from the result. One O(n log n) pass instead of O(n²) lag-by-lag.

**Owner / ETA.** Not allocated. Filed by dev-midi-p4 during Phase 4 validation.

---

## Multichannel Hankel — Phase B follow-ups (dev-mch, 2026-05-09)

**Phase A status:** Wired through end-to-end. `use_multichannel` flows
EspritConfig (Advanced section) -> `useModalAdapter.runEsprit` payload ->
`POST /modal/run_esprit` -> `EspritRunner.run_single_point` ->
`esprit_modal_identification` -> `_build_hankel`. Default `false` (no
behaviour change for existing projects). PlyWood-like users opt in via the
toggle; Belarus-like users keep the default.

**Phase B (deferred — owned by parallel multichannel experiment):**

1. **`model_order` sweep with multichannel.** Re-run the multichannel
   harness on Belarus while sweeping `model_order ∈ {8, 12, 18, 24, 32}`
   with the heuristic `model_order_multi = ceil(model_order_single *
   sqrt(n_channels))`. If `model_order=18` recovers the Belarus 89 Hz mode
   under multichannel, promote `use_multichannel=True` as the default in a
   separate PR with the `model_order` auto-bump baked into the runner.
   Harness scaffolding is at
   `PianoidCore/tools/grid_search/experiment_multichannel_hankel_phase_b.py`.

2. **Sanity check on the extra chains.** PlyWood multichannel found 9
   chains vs single-channel's 2; a follow-up should confirm the extra
   chains are real modes (per-chain cohesion stayed >0.92 in the experiment
   so this is suspected-real not suspected-spurious — but not yet verified).

See
[`docs/proposals/archive/multichannel-hankel-experiment-2026-05-08.md`](proposals/archive/multichannel-hankel-experiment-2026-05-08.md)
for the Phase A/B sequencing rationale (archived 2026-05-09 by dev-prophy after Phase B implementation).

---

## Effective Signal Length QC follow-ups (2026-05-05, dev-qc02)

**Status:** Cycle-level split (schema v2) shipped on PianoidCore
`feature/dev-qc02-qc-correct-sequence`. Median scenario T_eff on
PlyWoodTake1_1 went from 56.8 ms → 135.6 ms. Two of dev-qc01's three
zero-T_eff scenarios fully recovered; one residual remains.

### Deferred follow-ups

1. **Scenario 5 residual zero on PlyWoodTake1_1 — ROOT CAUSE
   IDENTIFIED 2026-05-06 (dev-qc02 close-out investigation).
   FIX LANDED 2026-05-06 by dev-cd0c (PianoidCore feature SHA
   `be0af10`, merge SHA `0612984`). The regex tighten described in
   "Proposed fix scope" below (Option A) is now in `dev`. Live
   re-run on the PlyWoodTake1_1 dataset to confirm
   `qc_global_min_t_eff_ms` is no longer 0 remains pending —
   dataset not in this workspace; the regex contract is covered by
   2 unit tests in `TestRawFileDiscovery`
   (`tests/integration/test_scenario_averager.py`).**

   **Symptom.** After the cycle-level split fix, Sc 5's worst response
   channel still gives `T_eff = 0.0 ms` while every other scenario
   recovered to ≥ 17 ms. Chart `dev-qc02-fix-bad-scenario.png` shows
   half_A and half_B diverging in amplitude from t=0.

   **Root cause.** The averager's raw-file regex
   `_ch(\d+)\.npy` (`scenario_averager.py:_list_raw_files_per_channel`)
   over-matches: it picks up two distinct artefact types living in the
   same `raw_recordings/` folder:

   - `raw_<scenario>_NNN_<ts>_chN.npy` — canonical multi-pulse
     measurements (~364800 samples = `cycle_samples × num_pulses` + extra)
   - `room_raw_<scenario>_NNN_<ts>_room_chN.npy` — single-pulse
     "room response" snippets (~28800 samples) generated by a
     different downstream consumer.

   When the averager treats a `room_raw_*` file as a measurement,
   `extract_cycles` zero-pads the 28800 samples to 240000 and reshapes
   into 5 cycles of 48000 samples each. Cycles 1-4 are pure zeros
   (fail validation as "Weak negative pulse"); cycle 0 may or may not
   pass depending on the negative-peak-width-samples gate. On Sc 5,
   cycle 0 of all 5 `room_raw_` files passes (width=4 samples, just
   above the 0.07 ms = 3.36-sample threshold). On Sc 19, cycle 0
   fails (width=2 samples, below threshold) — that's why Sc 19 is
   clean.

   The 5 surviving `room_raw_` cycle-0 entries pollute Sc 5's pool
   with cycles whose response amplitude is ~50 % LARGER than the
   canonical cycles (peaks 0.220-0.228 vs 0.144-0.153) — calibration
   normalisation does not equalise this because the snippets come
   from a different acquisition path. The cycle-level random split
   distributes these 5 outlier cycles asymmetrically between half_A
   (3 outliers) and half_B (2 outliers), producing the systematic
   amplitude offset visible in the chart from t=0.

   **Evidence.**

   - 80 raw files total in Sc 5: 40 are `raw_*` (5 measurements ×
     8 channels) and 40 are `room_raw_*` (same shape, different file
     stem prefix and signal length).
   - The measurement loop (`ensure_averaged_responses` lines 690-746)
     runs `extract_cycles` on each file, so the zero-padded
     `room_raw_*` cycles enter the canonical pipeline alongside real
     measurements.
   - Per-measurement validation outcomes for Sc 5:
     measurements 0-4 (`raw_*`): 4/5 cycles pass per measurement;
     measurements 5-9 (`room_raw_*`): only cycle 0 passes (rest are
     padded silence).
   - Cycle-pool peak-amplitude bimodal distribution: 20 cycles at
     ~0.148 ± 0.005 (canonical) + 5 cycles at ~0.222 ± 0.005
     (room_raw outliers).
   - Compared against Sc 19 (T_eff=160 ms, clean): identical file
     mix, but Sc 19's `room_raw_*` cycle 0 fails validation on the
     `negative_peak_width_samples` gate, so no outliers enter the
     pool.

   **Classification.** This is a **file-type-confusion bug in the
   averager's discovery logic**, not a hardware fault, signal-quality
   issue, or QC algorithm bug. The QC step is correctly flagging a
   real problem (the pool contains heterogeneous cycles); the bug is
   that the heterogeneity should never have entered the pool.

   **Proposed fix scope: SMALL** (~5-15 LOC).

   Tighten `_list_raw_files_per_channel` in
   `pianoid_middleware/modal_adapter/scenario_averager.py:129` so it
   only matches the canonical `raw_*_chN.npy` pattern and excludes
   `room_raw_*`-prefixed files. Two options:

   - **(A) Anchor the regex on the start prefix:**
     `re.compile(r'^raw_.*_ch(\d+)\.npy$', re.IGNORECASE)` —
     drops `room_raw_*` cleanly; keeps every legitimate
     `raw_<anything>_chN.npy` file.

   - **(B) Use file-size sanity check** — compute
     `expected_samples = cycle_samples × num_pulses` from metadata,
     then skip any file whose `np.load(..., mmap_mode='r').shape[0]`
     is < `expected_samples × 0.5`. More robust against future file-
     prefix variations but needs metadata available before file
     enumeration; the current code reads metadata AFTER file
     enumeration so this requires a small refactor.

   Recommend **(A)** — minimal change, stable contract, matches the
   live RoomResponse recorder's actual filename convention.

   **Tests required:** new fixture mixing `raw_*` and `room_raw_*`
   files in `raw_recordings/`; assert the averager picks up only the
   canonical files and Sc 5's QC produces a non-zero T_eff after
   the fix.

   **Validation plan post-fix:** re-run the averager on
   PlyWoodTake1_1 with `force=True`, expect Sc 5's
   `scenario_min_t_eff_ms` to land in the ~50-200 ms range (in
   line with the other 29 scenarios) and the new
   `qc_global_min_t_eff_ms` to no longer be 0.

   **Charts archived:** `dev-qc02-fix-good-scenario.png`,
   `dev-qc02-fix-bad-scenario.png` — kept in
   `docs/development/logs/` (not archived) as visual evidence for
   the follow-up agent.

2. **Threshold + aggregation tuning.** The dev-qc02 algorithm fix
   improves median T_eff substantially but doesn't yet hit the user's
   "300-600 ms" target on real data (current median 135.6 ms). User
   approved deferring this to a follow-up. Options to evaluate:

   - Loosen threshold from 0.1 to 0.15-0.25 (better matches signal
     decay vs noise floor in real impulse-response data; the
     `qc_threshold` field is already plumbed through REST so this can
     be tuned per-project without code changes).
   - Replace `min`-aggregation with `median` or `25th percentile` so
     a single noisy channel doesn't collapse the project value.
   - Add a "global noise floor" mode where T_eff is defined as
     "first sample where env_signal[t] < K × global_noise_estimate"
     instead of point-wise ratio.

   See dev-qc01 diagnosis report for details on each option.

3. **Frontend UI changes.** dev-qc02 backend exposes `qc_threshold` via
   REST but no UI surface. Per orchestrator dispatch plan, dev-cp01 (or
   a follow-up) will add: a threshold input field to CreateProjectDialog;
   improved warning text in EspritConfig listing how many scenarios are
   substandard + their T_eff range. Backend is ready when frontend is.

---

## Mode-Tracking default switch follow-ups (2026-05-05, dev-d773)

**Status:** `TrackingConfig.tracking_method` default changed from `sliding_window` →
`nuclei_merge` (PianoidCore `feature/dev-d773-subcluster-merge`). Existing tests
preserved by adding explicit `tracking_method="sliding_window"` where the test depended
on the old default; one test (`test_modal_adapter_grid_layout::test_default_tracking_method_unchanged`)
was renamed to assert the new default.  See
[`archive/MODE_TRACKING_NUCLEI_MERGE.md` § 8 "Default Promotion"](archive/MODE_TRACKING_NUCLEI_MERGE.md#8-default-promotion-dev-d773-2026-05-05).

### Deferred follow-ups

1. **Manual live-data validation on `tmp8c7q0lu0`.** The dev-d773 session could not
   construct a synthetic regression test that demonstrates nuclei_merge resolves the
   chain-7+8 case differently from sliding_window (three attempts documented in
   [`logs/dev-d773-2026-05-05-002518.md`](logs/dev-d773-2026-05-05-002518.md) "Honest
   assessment").  The fundamental issue: in any synthetic case where junk shapes
   mutually agree (so they cluster together in sliding_window), the junk-averaged MAC
   against the sub-cluster must be HIGHER than the sub-cluster's MAC against the clean
   chain — that's the math producing the over-broad cluster in the first place.  The
   real Belarus data must have an asymmetry we can't reproduce without it.

   **Action:** Re-run `/modal/run_tracking` on `tmp8c7q0lu0` post-merge with default
   `TrackingConfig()` and compare chain decomposition against the analyst's recorded
   sliding_window output (chain 7 + chain 8 separated near 50 Hz).  If nuclei_merge
   produces the same problematic 2-chain split, the chain-7+8 issue is NOT resolved by
   the default switch alone — escalate to Option B (sub-cluster-aware merge) as the
   actual fix.

2. **Live-data validation on Belarus + PlyWoodTake1.**  The previous default
   (sliding_window) was calibrated on Belarus; switching the default to nuclei_merge
   may produce different chain counts / coverage on Belarus too.  No regression in the
   synthetic test suite (485 unit tests pass), but real-data validation is needed
   before declaring the change "good for all datasets."  Originally listed as
   deferred in `MODE_TRACKING_NUCLEI_MERGE.md` § 7 — still pending.

3. **Frontend default UI surface.**  EspritConfig's tracking-method dropdown default
   selection should also switch to `nuclei_merge` to match the backend default.  If it
   still defaults to `sliding_window` post-merge, frontend users get a different
   default than backend callers — a discrepancy worth fixing.  Verify post-merge
   whether the dropdown picks up the backend default automatically (via a `/modal/...`
   bootstrap call) or hard-codes `sliding_window` in the frontend source.

---

## Per-band IR length follow-ups (2026-05-04, dev-ir01)

**Status:** Per-band `ir_length_ms` plumbing landed in dev-ir01
(`feature/per-band-ir-length` on PianoidCore + PianoidTunner). The `FrequencyBand`
dataclass gained `ir_length_ms: Optional[float]`; `process_band` slices the
input signal to that length BEFORE bandpass + decimation; `EXTENDED_BANDS` got
new defaults (Ultra-Low 1000ms/dec=4, Low 800ms/dec=4, Low-Mid 600ms/dec=4,
Mid+Mid-High 400ms/dec=2, High/Upper/Top 400ms/dec=1). The scenario averager
now accepts `ir_working_length_ms_override` so project creation can size the
averaged-response files to the longest per-band slice. Project creation also
persists the full `band_config` to `project.json` and `get_project_state`
synthesises an `esprit_config` from it for backward-compat hydration. The
frontend EspritConfig table gained an "IR (ms)" column; the Create Project
dialog gained an "IR (ms)" override field.

### Deferred follow-ups

1. **Doc update — `docs/guides/MODAL_ADAPTER_GUIDE.md`** (NOT in this PR; the
   file was locked by dev-3st1 for a parallel mode-tracking algorithm change).
   Sections to add when the lock releases:

   - **"Per-band IR length"** subsection under "Algorithm Overview" or near
     "Why Band-Splitting?", explaining the time-vs-decimation trade-off:
     `df = fs_band / L = 2 / T_total`, so resolution is preserved when you
     halve decimation AND halve sample count; only thing that changes is the
     usable Nyquist (anti-alias = `0.4 × fs_band`) which can be sacrificed
     when band f_max is well below it.
   - **"Project creation IR length"** subsection in "Project Management",
     documenting the new `ir_working_length_ms` form field on
     `POST /modal/projects/create` and `POST /modal/projects/create_from_zip`,
     defaulting to `max(b.ir_length_ms for b in band_config)` (1000 ms for
     `extended_8band`).
   - Update the `extended_8band` band table in the guide if/when the page lists
     them — drop the `window_length=12000/9600` for Ultra-Low/Low and add the
     new `decimation` and `ir_length_ms` columns.

2. **Full re-averaging endpoint — `POST /modal/projects/reaverage`**
   ✅ **LANDED in dev-cp01 (2026-05-05)** as
   `POST /modal/projects/<name>/reaverage`. Body:
   `{ir_working_length_ms: float (optional), force: bool (default true)}`.
   Wraps `ensure_averaged_responses_for_parent(force=True,
   ir_working_length_ms_override=...)` against the project's resolved
   measurement source folder. Persists the new `ir_working_length_ms`
   to `project.json`, refreshes QC. Used by the
   `EffectiveSignalLengthRerunDialog` follow-up prompt. See
   `docs/guides/MODAL_ADAPTER_GUIDE.md` "REST endpoints" under the
   Effective Signal Length QC section.

3. **Pre-existing test failure — `test_run_esprit_delegates_to_sync`**
   (`tests/unit/test_modal_adapter_state.py::TestEspritRefactor`). Fails on
   `dev` independently of dev-ir01 — introduced by [dev-0239] in 8b0796f
   when `_run_esprit_sync` started accepting a `scenario_indices` kwarg the
   test mock doesn't model. Mock signature needs updating, OR the production
   code's kwarg signature should be revisited if it changed unintentionally.
   ~5 LOC test fix. Not blocking any feature.

---

## Mode-Tracking `sequential` method follow-ups (2026-05-04, dev-c969)

**Status:** Soft deprecation landed in dev-c969. The implementation is kept working for
line-mode users who explicitly opt in (`TrackingConfig(tracking_method="sequential",
layout_type="line")`); `EspritRunner.run_tracking()` emits a `DeprecationWarning` when
that path is taken. The default `sliding_window` method is unchanged.

### Hard removal — schedule one release cycle out

After ~one release cycle of the soft deprecation (target: dev-c969 + 1 month, i.e. on
or after 2026-06-04), if no downstream code or external project has complained, perform
the **hard removal** in a follow-up `/dev` session. Removal scope:

1. **Source** — `pianoid_middleware/modal_adapter/esprit/mode_tracking.py`:
   - Remove the `_run_tracking_sequential` branch in
     `track_modes_along_bridge()` (currently L745-896, ~150 LOC). The dispatcher
     becomes `_track_sliding_window`-only.
   - Remove the sequential-only `TrackingConfig` fields: `freq_tol_pct`,
     `freq_envelope_margin`, `trend_window`, `trend_decay`, `mac_reject_threshold`,
     `mac_weight`, `max_shape_drift_rate`, `shape_drift_freq_relax`,
     `shape_drift_weight`, `freq_weight`, `max_cost`, `no_assign_cost`, `max_gap`,
     `reference_shape_alpha`. Or keep them as no-op shims for backward-compat at
     `TrackingConfig(...)` construction sites — TBD by removal-PR author.
   - Remove `_compute_cost`, `extrapolate_frequency`, `_merge_split_chains`,
     `match_chains_cross_bridge`, `merge_cross_bridge_chains` (all sequential-only).
   - Remove the `tracking_method` selector entirely (only one method left).
2. **Source** — `esprit_runner.py`:
   - Remove `_run_tracking_sequential` (and its `DeprecationWarning`).
   - Inline `_run_tracking_sliding_window` into `run_tracking` directly.
3. **Tests** — `tests/unit/test_mode_tracking.py`:
   - Remove the entire `TestSequentialDeprecation` class.
   - Remove all tests that specify `tracking_method="sequential"` (test_sequential_*,
     SEQ shorthand at L30, etc.) — roughly half the file, currently ~500 LOC.
4. **Docs** — `archive/MODE_TRACKING_REDESIGN.md` (archived 2026-05-16, docs-modetrack-streamline):
   - Already retired to the archive as historical design rationale. The cost-function
     design § 4.2-4.4 is sequential-only; no further action needed beyond the archival
     unless the hard-removal author wants to trim it.
   - Update `MODAL_ADAPTER_GUIDE.md`'s tracking-method table to drop the second column
     and remove the "DEPRECATED" callout.
5. **Frontend** — check `PianoidTunner` for any UI control exposing `tracking_method`
   selection. If present, hide / default-pin to `sliding_window`. The `freq_tol_pct`
   and `max_gap` UI fields become dead — either remove them or repurpose for documenting
   `sw_*` parameters.

**Pre-removal verification checklist** (run before scheduling the hard-removal `/dev`):

- `pytest tests/unit/test_mode_tracking.py tests/integration/test_modal_adapter_e2e.py`
  on a recent dev branch — confirm no test still depends on sequential output values
  for correctness (only deprecation-warning suppression should remain).
- `git log --since="2026-05-04" --grep="sequential" --grep="tracking_method=\"sequential\""`
  in PianoidCore + PianoidTunner — look for downstream code adopting sequential after
  the deprecation.
- Search downstream Pianoid forks / external integrations (if any tracked) for
  `tracking_method="sequential"`.

---

## Modal Adapter Grid Layout MVP follow-ups (2026-05-04)

**Status:** Landed in dev-b9dd (`feature/modal-adapter-grid-layout`). High #1 (P1
contract validator on `point_coordinates` keys) was folded in before commit. The
following findings from the same /review pass were deferred per user direction.

### High (waived for this PR — schedule before next touch)

- **C4 RED file growth (waived).** Five already-RED files grew further this PR:
  - `pianoid_middleware/modal_adapter/modal_adapter.py` 2981 → 3106 LOC
  - `PianoidTunner/src/hooks/useModalAdapter.js` 1378 → 1479 LOC
  - `PianoidTunner/src/modules/ModalAdapter.jsx` 1133 → 1242 LOC (1211 from grid + 31 from accordion)
  - `pianoid_middleware/modal_adapter/esprit/mode_tracking.py` 1215 → 1269 LOC
  - `PianoidTunner/src/components/StabilizationDiagram.jsx` 2231 → 2252 LOC

  Pre-existing debt; user explicitly waived for this PR. **Schedule:** before the
  next feature touching ANY of these files, extract one helper:
  - **Recommended first split:** `get_grid_heatmap_data` → new
    `pianoid_middleware/modal_adapter/grid_heatmap.py` (~120 LOC out of `modal_adapter.py`)
  - **Recommended second split:** `useModalAdapter.js` grid-mode state +
    setters + `getGridHeatmap` fetcher → new `useGridLayout.js` hook (~150 LOC out)

### Medium (deferred follow-ups)

- **Heatmap error visibility.** `useModalAdapter.js:getGridHeatmap` and
  `GridHeatmapInset.jsx` swallow backend error messages — heatmap shows generic
  "no data" for everything (no tracking, wrong layout, chain out of range,
  network error). Surface the backend error string. ~10 LOC fix in both files.

- **Grid cell keyboard a11y.** Cells in `GridLayoutEditor.jsx:241-269` aren't
  keyboard-accessible (no `tabIndex`, `role="button"`, `aria-label`,
  `onKeyDown`). Add per project Frontend UI Standards in `.claude/CLAUDE.md`
  (the "Accessibility Baseline" section explicitly requires keyboard nav for
  all interactive elements).

- **Bulk shape buttons have no undo.** All On / All Off / Invert wipes the
  entire mask in one click — easy to lose a carefully-painted custom shape.
  Add a local undo stack OR a confirmation step.

- **Component-semantics fix.** `GridLayoutEditor.jsx:195-199` uses
  `<ToggleButtonGroup exclusive>` for action buttons (All On / All Off /
  Invert) — semantically these are independent actions, should be
  `<ButtonGroup>` not `<ToggleButtonGroup>`. The component renders correctly
  but the DOM/a11y semantics are wrong.

### Low (cleanups)

- **S3 — row-major-cell-walk duplication.** Six instances of the row-major
  walk over `cell_mask` populated cells across frontend + backend
  (`GridLayoutEditor.jsx`, `useModalAdapter.js`, `modal_adapter.py`,
  `mapping.py`, the new `_validate_grid_layout`, and the GRID-button init in
  `ModalAdapter.jsx`). Extract a `populated_cells_in_row_major(cell_mask)`
  helper on each side of the wire.

- **A4 — frontend default grid params inlined.** The "switch to GRID"
  initializer in `ModalAdapter.jsx:583-616` hardcodes `[4, 4]` shape +
  `10mm` spacing + all-cells-populated. Either codify in `MappingConfig`
  module-level constants (preferred — single source of truth) OR document.

- **Test gap — line-mode payload bit-identicality.** No test asserts that
  `submitChannelMapping` for `layout_type="line"` produces a JSON payload
  bit-identical to the pre-grid contract. Add a small HTTP-payload roundtrip
  test in `tests/integration/test_modal_pipeline_payload.py` to lock in the
  backward-compat guarantee.

### Cosmetic note (not from this PR)

- **Pre-existing `Box children` PropType warning.** The browser console fires
  a `Warning: Failed prop type: Invalid prop 'children' supplied to
  ForwardRef(Box), expected a ReactNode. at ModalAdapter` warning on every
  Modal Adapter render. Verified to predate this PR (fires before any new
  code path executes on first page load). Track separately if it bothers
  anyone — not a regression introduced by grid layout.

---

## Modal Adapter create_from_zip + auto-averaging (2026-05-04)

**Status:** Landed in dev-0239. Follow-ups deferred per user direction.

The new `POST /modal/projects/create_from_zip` endpoint (multipart upload,
streamed via Werkzeug) handles both `.pianoid-project` archives and raw
measurement-data zips in one call. For measurement-data zips it auto-extracts
to `D:\modal_measurements\<name>\` (or `$PIANOID_MEASUREMENTS_DIR`) and runs
the canonical RoomResponseRecorder averaging pipeline (validate → align →
normalize → average → truncate-with-fadeout) on every scenario lacking
`averaged_responses/`. Idempotent — pre-existing averages are never
overwritten. Frontend "Import Project" button now smart-routes by file
extension; success alert reports the averaging breakdown.

**Implementation:** `PianoidCore/pianoid_middleware/modal_adapter/`
`scenario_averager.py` (new, ~370 LOC) + `modal_adapter.py` +
`routes.py`; `PianoidTunner/src/hooks/useModalAdapter.js` +
`src/modules/ModalAdapter.jsx`; `docs/guides/MODAL_ADAPTER_GUIDE.md`.

**Tests:** 27 pass (10 new in `tests/integration/test_scenario_averager.py`,
17 in `tests/integration/test_modal_create_from_zip.py` of which 2 new).

### Deferred follow-ups

- **Medium #2 — Doc rot in REST API JSON example.** The sample JSON in
  `docs/guides/MODAL_ADAPTER_GUIDE.md` "REST API → Project Import /
  Create-from-Zip" block does NOT include the `averaging_summary` field
  in the `create_from_zip` response example, but the live endpoint
  always returns it. ~5 LOC doc fix to add the field to the example
  alongside the existing `name`/`path`/`extracted_path`/`detected_format`
  keys. Standalone — no code touch required.

- **Medium #3 — Failed-averaging scenarios silently dropped.** When the
  averager returns `status="error"` for a scenario, that scenario
  doesn't get `averaged_responses/` written, so the downstream
  `_discover_roomresponse_scenarios` discovery skips it. The response
  shape exposes `averaging_summary.errors` (count) and
  `averaging_summary.failed_scenarios` (list of `{scenario, error}`),
  but `scenario_indices` only contains the scenarios that DID land in
  the project. The two are not cross-correlated in the UI — a user
  could see "Scenarios imported: 28" + "Averaging errors: 2" and not
  immediately know WHICH scenario indices got dropped. Recommend
  adding `dropped_due_to_averaging_failure: [scenario_idx_list]` to
  the response shape (parsed from `failed_scenarios` by mapping
  scenario folder name → integer via the same regex used by
  `_extract_scenario_index`). ~10 LOC + 1 test.

- **Medium #4 — `routes.py` is 971 LOC (29 under the project's RED
  threshold of 1000 LOC).** Adding `create_from_zip` brought it close
  to the cliff. Plan a split (e.g. `routes_projects.py` for the
  project lifecycle endpoints, `routes_pipeline.py` for the
  ESPRIT/tracking/feedin endpoints, `routes.py` keeping the blueprint
  + shared helpers) BEFORE the next routes-touching session. No
  immediate user-facing impact; structural debt only.

- **Low #1 — Cross-repo bootstrap probe gap.** `scenario_averager.py`
  imports `signal_processor` and `calibration_validator_v2` lazily
  per-scenario. If the sibling RoomResponse repo is at the right path
  but those specific module names get renamed/moved upstream, every
  scenario in an import would silently fall through with `status=error`
  with no aggregated user-visible warning. Could add a one-time probe
  in `_auto_average_scenarios` that returns a top-level
  `averaging_unavailable: true` flag + skips the whole walk if neither
  module is importable. ~15 LOC.

- **Low #2 — No version/contract assertion against RoomResponse.** The
  averager uses three RoomResponse APIs (`SignalProcessor.average_cycles`,
  `align_cycles_by_onset`, `normalize_by_calibration`) plus
  `CalibrationValidatorV2.validate_cycle` and the
  `validation_results` dict shape. If RoomResponse refactors any of
  these signatures, the averager errors per-scenario without a clear
  diagnostic. Could add a smoke import + interface check at
  modal-adapter-server startup. ~10 LOC.

- **Low #3 — CI without RoomResponse silently skips 4 tests.** The
  `TestCanonicalPipeline` class in `test_scenario_averager.py` is
  `@pytest.mark.skipif(not _HAS_ROOMRESPONSE)`. CI machines without
  the sibling repo will pass with 4 tests skipped. Acceptable today
  (the canonical-pipeline coverage IS sound on dev boxes), but a
  future CI hardening pass should either bootstrap RoomResponse on
  CI or assert the canonical tests aren't skipped.

- **Low #4 — S3 first-hit-rule duplication between
  `_auto_average_scenarios` and `_detect_measurement_source`.** Both
  helpers walk root + first-level subdirs looking for the
  measurement parent. They do agree on ordering today (alphabetical
  sort), but the duplication is a S3 (no-duplication) violation — a
  future refactor should extract a single `_walk_for_measurement_root()`
  helper. ~15 LOC.

- **Low #5 — Multi-line `window.alert` in `ModalAdapter.jsx`.** The
  success alert builds a multi-line `\n`-separated string for
  `window.alert`, which renders as a system modal that's hard to
  copy/paste from. Consistent with the pre-existing pattern in this
  module (e.g. the "name conflict resolved" alert) so not a regression,
  but the long-term direction is MUI Snackbar/Alert with a "View
  details" expand for the averaging summary. Tracked at the
  module-wide level rather than per-handler.

---

## Orchestrator Session Pause — 2026-05-01

User paused all work for a computer restart. Full session state captured at:

**[`orchestrator-session-state-2026-05-01.md`](archive/orchestrator-session-state-2026-05-01.md)**

That file contains: today's commits in chronological order, engine bug cluster status (Bug A + Bug #2/#3 fixed; Bug #1 paused with corrected diagnosis), the immediate-resume decision queue (Bug #1 a/b/c/d call), Modal Adapter integration status (B-0/B-1/B-3 landed, B-2/B-4/B-5/Q4 ports deferred), CLAUDE.md/dev.md reorganization details, memory updates, and stack restart instructions. **Resume here after reboot.**

---

## Mode Parameter Handling Audit (2026-04-29)

**Status:** Session 1 committed. Sessions 2 and 3 pending.

A `/analyse` audit of mode parameter handling produced a 4-pillar report (math/physics, UI routes, debug tools, improvements). Full plan: 3 /dev sessions.

| Session | Scope | Status |
|---|---|---|
| S1 | Bug fixes + doc rot — `/set_mode_parameters` side-effect, `PanoidResult.get_record` axis hardening, DATA_FLOWS / DEBUG_DATA / REST_API / chart_config refresh | **Done** — `8305614` (PianoidCore) + `3ae58fd` (PianoidInstall) |
| S2 | `play_mode` returns populated `PianoidResult`; new accessors `get_mode_state` / `get_synth_audio` / `get_mic_audio` / `set_mic_audio`; chart functions `play_mode_chart_function` + `pure_mode_test_function` collapsed into one `mode_test_function` with `view_mode` + `coupling` selectors | **Done** — `d48a08e` (PianoidCore) |
| S3 | UI/parameter mass/stiffness handling — stiffness + damping rendered read-only in `Mode.jsx`; recompute rule enforced: frequency edit → stiffness, keep mass; mass edit → stiffness, keep frequency; decrement edit → damping; client-side optimistic recompute in `usePreset.js`; backend `parameter_manager` strips derived fields; `pack_for_interface('mode')` returns 5 values | **Done** — `5cc05ee` (PianoidBasic) + `8c8bd92` (PianoidCore) + `2656027` (PianoidTunner) |
| S3-deploy | Stale-wheel hardening: bump PianoidBasic version 0.1.13 → 0.1.14 so pip detects an upgrade on next setup-dev / build_pianoid_cuda; new REST integration test `test_mode_param_independence.py` asserts the rule end-to-end so a future stale-install slip surfaces in CI | **Done** — `c67bdcc` (PianoidBasic) + `24ce350` (PianoidCore) |

### REST / endpoint protocol issues surfaced during S3 verification (2026-04-30)

These were discovered while testing the mode-parameter rule via REST and represent doc rot or unfortunate signatures worth tracking for future cleanup. None are S3-specific; they affect any REST client (CI tests, scripts, or future skills).

- **`/load_preset` request key drift:** the canonical key is `debug_mode` (int 0/1), NOT `use_debug_build` (bool) as documented in some places. The body silently ignores unknown keys, so a wrong-key request loads the release binary. Audit `docs/modules/pianoid-middleware/REST_API.md` for `use_debug_build` references and reconcile with the actual handler in `backendServer.py`. Also: `/load_preset` raises KeyError if `listen_to_midi`, `use_simulation`, `string_iterations`, `audio_on`, `start_right_away`, `sample_rate` are missing — no defaults. Worth adding sensible defaults or documenting the required-fields list explicitly.
- **`PIANOID_USE_DEBUG=1` must be set BEFORE backend launch:** `select_cuda_variant` in `pianoid.py:54` checks `if "pianoidCuda" in sys.modules` to decide which variant to load. `pianoid.py` itself imports `pianoidCuda` at module top, so by the time the backend's `if __name__ == "__main__"` block reads the env var, the release binary is already loaded and the variant cannot switch. The launcher's `/load_preset` `debug_mode=1` flag also can't change this once the process is alive. Already known and tracked under "pianoid.py:54 debug-variant module-load-order trap" in this section's Deferred items, but worth re-emphasising for any test author.
- **`/set_parameter/mode/<idx>/<field>` route does NOT exist:** `backendServer.py:953` exposes `/set_parameter/<type>/<idx>` (no field component); the body shape is `{"<idx>": {"<field>": value}}`. Update REST_API.md mode-update section if it currently shows the per-field URL.
- **`pack_for_interface('mode')` returns a tuple `(dict, 'OK')`** rather than just the dict (`pianoid.py:2474`). Internal callers know this; new test/integration code is likely to drop the tuple unwrap and silently treat `'OK'` as the parameter set. Either rename the helper or document the return shape clearly.
- **Flask auto-reloader hardcoded:** `socketio.run(debug=True)` in `backendServer.py:3016` makes the dev server watch the source tree and restart on any change — including `.pyc` writes. This drops the live `pianoid` global mid-test and breaks any in-process test that hit `/load_preset` then a follow-up endpoint. Workaround: launch backend with `PYTHONDONTWRITEBYTECODE=1`. Real fix: gate `debug=True` behind an env var (`PIANOID_FLASK_DEBUG=1` or similar), default to `debug=False`.

### Deferred follow-ups

- ~~**Backend parameter safety net (post dev-2706)**~~ — **FIXED 2026-05-03 (dev-9a47).** `parameter_manager.py` now exposes `validate_engine_param(kind, field, value)` and raises `ParameterRangeError` (a `ValueError` subclass) with a structured message. REST handlers in `backendServer.py` catch it and return HTTP 400; WS handlers emit `error` with `code: "parameter_range_error"`. Final guard set: `mode.mass_inv <= 0`, `(excitation|gauss).sigma <= 0`, `mode.frequency < 0`, `mode.decrement < 0`, plus a universal NaN/Inf guard on every numeric field (5th catastrophic predicate, applies to all parameter types). Wired into `update_parameter` ('mode', 'excitation', 'gauss' branches), `update_pitch_excitation` (per-pitch curve path), and `/set_mode_parameters` (legacy route). Regression test: `tests/integration/test_parameter_safety_net.py` (43 cases — predicate units, payload-shape validators, REST integration, engine-state-not-corrupted contract). Routes annotated in `docs/modules/pianoid-middleware/REST_API.md` "Engine safety net (catastrophic-input rejection)". CODE_QUALITY.md S5b updated to mark closure. **Range bounds beyond catastrophic predicates were intentionally NOT added** — the user's dev-2706 directive was to remove UX clamps; this safety net is hard-correctness, not UX defense.
- ~~**MIDI notes sound twice — `/play` cross-transport dedup gap**~~ — **FIXED 2026-05-03 (dev-md01).** The user-reported regression "MIDI notes sound twice" + "the was a filter against it" traced back to a split-state dedup. The original module-global filter (`eabf0b6`, 2025-05-20) caught every duplicate when REST `/play` was the only ingress. Commit `c49a0dd` (2026-04-11) added Flask-SocketIO + a parallel WS `play` handler with its own per-SID `_ws_last_command`, leaving `last_command` as REST-only. The two stores never cross-updated, so a duplicate that crossed transports (one event via WS, the duplicate via REST — common during a transient WS reconnect where `usePreset.playNote` falls back to REST) OR came from a different WS SID (e.g. multiple browser tabs) passed both filters. Confirmed by direct measurement against the running backend (`D:/tmp/midi_dedup_probe.py`): pre-fix, cross-transport WS→REST and cross-SID WS1→WS2 each produced a +1 event delta; post-fix, both produce +0. Fix: collapsed the two stores into a single shared module-global `_last_play_cmd_key` with a thread-safe helper `_is_duplicate_play(mapped_d1, command)`. All four duplicated dedup branches in `backendServer.py` (WS unified, WS legacy, REST unified, REST legacy) route through the same helper (S3 no-duplication, P1 single-source-of-truth). Disconnect cleanup is no longer needed (no per-SID slot). Regression test: `tests/system/test_play_dedup.py` (8 cases — same-transport REST + WS, cross-transport WS→REST + REST→WS, cross-SID, distinct-events sanity). Doc-gap closure: `docs/modules/pianoid-middleware/REST_API.md` `/play` section now documents the dedup contract (was undocumented pre-fix). The frontend was NOT changed — the bug was purely backend-side in how the two transport handlers shared dedup state.
- **C++ `circular_buffer_chunks` default is wrong for SDL3** (`Pianoid.cuh:51`) — struct default is `4` (the ASIO buffer size); SDL3 driver requires `>= 16` per the same comment. dev-f99c (2026-05-01) patched the symptom in the Python helper `pack_initialization_params_for_cuda` so `audio_driver_type=0` and `==3` set `circular_buffer_chunks=16` explicitly, but any future caller that constructs `InitializationParameters` directly (e.g. a new in-process test, an out-of-tree consumer of pianoidCuda) and selects SDL3 without overriding the chunks field will hit the same in-place-reload underrun. Proper fix: clamp `circular_buffer_chunks` inside `SDL3AudioDriver` constructor (or `AudioDriverFactory::createDriverWithType`) when the requested value is below the SDL3 minimum, so the C++ side enforces its own invariant. Requires CUDA work — separate /dev session.
- **`use_simulation`/`use_placeholder` placeholder is vestigial — decide rewrite vs. retire** — `pianoid_cuda_placeholder.py` was a pre-library-API stub used to develop middleware Python without a CUDA build. It has not been kept in sync since the library-API refactor: `Pianoid.__init__` signature is wrong (caller passes `(strings_in_pitches, sm=self.sm)` but stub takes `(gauss_params, strings_in_pitches, sm=False)`); methods needed by current `init_pianoid` are absent (`loadPresetToLibrary`, `switchPreset`, `setRuntimeParameters` / the `pianoidCuda.RuntimeParameters` class, `shutdownGpu`). dev-b001 (2026-05-01) closed the destructive symptom by rejecting `use_simulation=1` at the Flask layer with HTTP 400. The decision deferred is whether to **(a)** rewrite the placeholder to the library-API surface (~200 LOC + expose additional `pianoidCuda.*` classes from the placeholder side) so headless-Python middleware development is possible again, **(b)** retire the feature outright — drop `use_simulation` from `/load_preset` body, drop `use_placeholder` kwargs through the call chain, delete `pianoid_cuda_placeholder.py`, also update the WIP S3 deferred note about `/load_preset` "raises KeyError if `use_simulation` is missing — no defaults" by removing the field, or **(c)** make it a frontend-only feature (drop the kwarg flow but keep a no-op for legacy clients). Prior frontend work that referenced `use_simulation` still exists; option (b) needs a frontend grep. Tracked from dev-b001 fix 2026-05-01 — the 400 guard is surgical scope-limited; the cleanup is the principle-violation (S3 no-duplication / S5 fail-fast) that the 3-line patch smell test surfaces.
- **`Pianoid::getSoundRecords` buffer-width bug** (`Pianoid.cu:1487`) — hardcodes the host buffer width to `num_strings * NUM_PARAMS_IN_SOUND_RECORD`, but mode-indexed records (record 1 `SOUND_REC_MODE_STATE`, record 3) are written by `modeNo`. Any future preset with `num_modes > num_strings` will overflow the kernel-side write. S1 added Python-side bounds clamping in `PanoidResult.get_record`, but the underlying C++ buffer needs resizing to `max(num_strings, num_modes)`. Requires CUDA work — separate /dev session.
- **Expose `Pianoid::getModeDisplacements` to Python and the UI** — C++ method already returns `[q, q_prev, dec, omega, mass]` in a single D2H call, no debug build required. No Python wrapper or chart function consumes it today. Would replace the debug-only `record 1` path for release-safe mode inspection. Lower priority since S2 may obviate it via the unified play_mode flow.
- **0xF1 TEST_MODE_ONLY MIDI status byte** — `EventDispatcher::dispatch` (`EventDispatcher.cu:189`) handles a custom MIDI status `0xF1` for `addModeExcitation`. Not documented in REST_API.md or any event-system doc. Captured in `play_mode_chart_function` but otherwise undocumented. Address in S2's documentation pass or as a standalone doc-only fix.
- **Math/physics primer** (proposed `docs/modules/pianoid-cuda/MODE_PHYSICS.md`) — covers `frequency↔omega` and `decrement↔dec` discrete mappings, dt asymmetry between string and mode updates, `(1-dec)` damping factor, SoA layout. Currently fragmented across `SYNTHESIS_ENGINE.md` and `Mode.py`. Standalone doc-only task; can be addressed at any time.
- **`test_derivative_comparison` 2 new failures** (2026-04-28) — surfaced during the mass→mass_inv rename and chartFunctions/chart_config refactor in this session. Suspected real regression introduced by C-1 demote, chart_config edits, or the rename. Investigate which commit broke the assertions; either fix the test expectations or revert the underlying behaviour change.
- **npm `@latest` MCP server fragility** — `~/.claude.json` mcpServers entries use `npx -y X@latest` for chrome-devtools, context7, and google-drive. Long-running orchestrator sessions can lose stdio pipes to these servers; they don't auto-reconnect, so the only recovery is a VS Code reload. Mitigation: pin versions (e.g. `@1.4.7`) instead of `@latest` in `~/.claude.json` so a transient `npx` re-resolve can't pull a different binary mid-session.
- **Apply Frontend State Discipline (3 principles) to remaining matrix editors** — Phase B5 audit (dev-833f, 2026-04-30) identified the same H3 anti-pattern (speculative-emit useEffects + non-presetVersion-driven re-init) in PianoidTuner.js for these editors: deck Feedin (`PianoidTuner.js:987-996`), deck Feedback (lines 1014-1023), Strings (lines 1029-1109), Modes (lines 1129-1198), Excitation (lines 1208-1318, partially mitigated via `skipExcitationSyncRef`). Phase C2 refactored only the SC editor as the reference implementation (~230 LOC). Refactoring all five remaining editors is ~600 LOC delta in PianoidTuner.js plus per-editor regression tests (~400 LOC), with integration-regression risk in selection/highlighting/workbench coordination. User has not yet reported H3 symptoms in those editors but the principles apply project-wide. Tracked from dev-833f Phase B5 audit 2026-04-30. See `docs/architecture/SYSTEM_OVERVIEW.md` "Frontend ↔ Backend State Discipline" and `docs/modules/pianoid-tunner/OVERVIEW.md` for the SC editor pattern to follow.
- ~~**Cross-mode-count `/preset/switch` crashes engine**~~ — **FIXED 2026-05-01 (dev-c529).** Root cause was the Python-side `switch_preset` in `pianoid.py`: it swapped `self.sm` and `self.modes` from `_library_models[name]` but dropped `self.mp`, leaving `mp.num_modes` permanently stuck at whichever preset was loaded FIRST. Two failure modes via `parse_range`/`pack_for_interface`: (a) Belarus(196) → Baseline(100) over-indexed the smaller deck arrays, raising `IndexError` and HTTP 416; (b) Baseline(100) → Belarus(196) silently truncated to 100 of 196 mode coefficients per pitch. Two-line fix: also assign `self.mp = model['mp']` and propagate to `param_manager.mp`. Regression test: `tests/system/test_preset_switch_mode_count.py` (3 cases — both directions + param_manager mp sync). Originally tracked from dev-833f Phase D3 R7 (2026-04-30).
- ~~**Listen-mode toggle + APPLY destroys engine on Belarus**~~ — **FIXED 2026-05-01 (dev-b001) — corrected diagnosis.** The "listen-mode toggle" framing was a misleading correlation. dev-eng-bug-1-r's Phase A counter-finding (2026-05-01) established via measurement that the real destructive parameter was `use_simulation=1` (which the UI auto-flipped during APPLY in some sequences) and the bug reproduced **on all presets** (Baseline + Belarus + others), with any listen_mode setting. dev-b001 confirmed: pre-fix, POST `/load_preset` with `use_simulation=1` returned HTTP 500 `TypeError: Pianoid.__init__() missing 1 required positional argument: 'strings_in_pitches'` AND destroyed the live engine (`destroyPianoid()` ran on line 666 BEFORE the failing init). Root cause: `pianoid_cuda_placeholder.Pianoid.__init__(self, gauss_params, strings_in_pitches, sm=False)` has been left to bit-rot — three params with `gauss_params` first, but the caller in `pianoid.py:1775-1778` only passes `(strings_in_pitches, sm=self.sm)`. Even if the constructor signature were repaired, the placeholder is missing the entire library-API surface (`loadPresetToLibrary`, `switchPreset`, `setRuntimeParameters` / `RuntimeParameters` class, `shutdownGpu`) that `init_pianoid` calls immediately after. Fix: reject `use_simulation=1` with HTTP 400 `FeatureNotSupported` BEFORE destroying the engine — surgical scope-limited 17 LOC guard at the top of `backendServer.py:load_preset_route`. Regression test: `tests/system/test_use_simulation_rejected.py` (5 cases — HTTP 400 + error code + message content + engine-not-destroyed contract via patched global + control: `use_simulation=0` and missing field both pass the guard). REST_API.md updated with `use_simulation` field semantics and the 400 response body. The placeholder cleanup itself (rewrite or retire) is filed below.
- ~~**In-place `/load_preset` with audio_driver_type=0 crashes engine**~~ — **FIXED 2026-05-01 (dev-f99c).** Root cause was in `pack_initialization_params_for_cuda` (`pianoid.py:2001-2003`): the type=0 path set `init_params.audio_driver_type = -1` (compile-time default sentinel) but left `circular_buffer_chunks` at the struct default of `4` (ASIO buffer size). On Windows builds compiled with both `USE_ASIO_AUDIO` and `USE_SDL3_AUDIO`, the C++ side resolved `-1` to the compile-time default driver — but with the buffer depth left at the ASIO default, the SDL3 driver re-construction on the SECOND in-place `/load_preset` reload (with the audio thread already running) failed during reinit. The exception was caught by `run_online`'s try/except so the process didn't die hard; instead the engine entered `audio_driver_active=false, exception=true` (visible in /health). First-time loads worked because the smaller buffer was still drained successfully on a fresh init. Fix: pin type=0 explicitly to `pianoidCuda.AudioDriverType.SDL3` AND set `circular_buffer_chunks=16` (matching what type=3 does). 8-line code change. Regression test: `tests/system/test_load_preset_audio_driver_type_0.py` (3 cases — pin-to-SDL3, type-0 == type-3 contract, clean engine state with audio_off). Note: the original WIP description's claim that /health returns `pianoid_loaded:false, gpu_initialized:false` was inaccurate — actual symptom is `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:false, exception:true`. The "default driver = no driver" framing in `tests/system/conftest.py` was also misleading: the in-process fixture works because it never calls `startApplication` (driver constructed but never `init()`'d), not because the type=0 path was hardware-free. Originally tracked from dev-833f Phase D3 audio_off-strict re-verification (2026-04-30).
- ~~**`/load_preset` with audio_driver_type=3 (SDL3) fails: "missing strings_in_pitches"**~~ — **RESOLVED with the audio_driver_type=0 fix above (dev-f99c, 2026-05-01).** Independent investigation 2026-05-01 (orchestrator-spawned read-only agent) could NOT reproduce on a clean backend with audio_driver_type=3 — fresh /load_preset with type=3 returns 200 OK every time. Root cause: there is only ONE `pianoidCuda.Pianoid()` constructor call in middleware (`pianoid.py:1813-1816`), identical for all driver types — no driver-type branching around the constructor. dev-de72's original observation occurred after killing stale processes + restarting backendServer — likely state-corrupted reload from a prior failed init produced by the type=0 underrun bug above. Post-fix verification by dev-f99c: type=3 load returns 200 OK with `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:true, exception:false`. Related independent finding: `tests/unit/test_mic_analyzer.py:74,265` has a wrong comment claiming driver_type=3 is "ASIO" (it's SDL3 in Python middleware mapping; ASIO_CALLBACK in C++ enum) — doc-only fix, separate small follow-up.

---

## Audio Testing Modes Enforcement (2026-04-29)

**Status:** C-1 / C-2 / C-3 / C-4 committed. C-6 / C-7 partial: TESTING.md, CLAUDE.md, and 5 skill MDs (test-ui, pianoid-ui, diagnose, dev, fn) updated to enforce strict-A1 audio_on / audio_off binary contract. The full plan is summarised in [TESTING.md](TESTING.md). The /play_keyboard contract change (original C-5) is deferred — see deferred items below.

| Phase | Scope | Commit |
|---|---|---|
| C-1 | DEMOTE — driver-off conversions, register markers | `415d130` (PianoidCore) |
| C-2 | test_performance SPLIT into _audio_off + _audio_on | `acc717b` (PianoidCore) |
| C-3 | PROMOTE — test_playback / test_asio_multichannel / cycle_profile mic+compare | `a95500a` (PianoidCore) |
| C-4 | Frontend indicator split — Synth + Audio Chips | `aedb6ff` (PianoidCore) + `f287e57` (PianoidTunner) |
| C-5 | /play_keyboard contract clarification + deprecation warn | **Deferred** — see below |
| C-6 / C-7 | TESTING.md, CLAUDE.md, 5 skill MDs | This commit |

### Deferred items

- **TestSynthReachesMic verification** — needs speaker→mic loopback configured on the dev box. Currently skipped via `@pytest.mark.skip(reason="deferred: speaker→mic loopback verification pending")`. Flip `_MIC_LOOPBACK_CONFIGURED=True` in `tests/system/conftest.py` once the loopback is set up; the entire audio_on suite re-enables in lockstep.
- **`cycle_profile.py --audio-mode=audio_off` variant** — currently exits 1 with a WIP-pointer message ("audio_off variant not yet implemented; use tests/system/test_performance_audio_off.py for offline timing"). Implementing requires a kernel-only timing path in cycle_profile that doesn't engage the driver.
- **`test_asio_multichannel` tight per-channel transferRatio calibration** — current implementation uses lenient `transfer_threshold=1e-3` per channel. Tight calibration needs a known-good mic-position calibration asset.
- **`/play_keyboard` mode=online,capture_mic=false strict-A1 ambiguity** — the path engages the driver without a mic. Original C-5 plan was to deprecate this combination with a warning, then remove in follow-up. Deferred per user direction.
- **F5 callback-stats reproduction** — `probe_f5_silent_engine.py` was demoted to audio_off, so its callback-stats output is no longer meaningful. If a future stream investigation reopens, the probe needs to be promoted to audio_on (with mic loopback) or replaced.
- **Calibration REST endpoint test coverage** — `/calibrate_volume`, `/measure_rms`, `/equalize_keyboard`, `/tune_note` are the canonical audio_on REST surfaces but have no automated test coverage today. Future audio_on test development should target these.
- **`pianoid.py:54` debug-variant module-load-order trap** — `select_cuda_variant(use_debug=True)` checks `if "pianoidCuda" in sys.modules`, but `pianoid.py` imports pianoidCuda at module top, so by the time `from pianoid import initialize` returns, the release binary is already loaded and the warning "pianoidCuda already imported -- cannot switch to debug variant" fires. Affects ALL standalone scripts that request `use_debug_build=True` (cycle_baseline.json sets this true). Standalone scripts silently run against the release binary instead. Requires reordering pianoid.py imports — separate /dev session.
- **`cycle_profile.py --matrix` single-process iter hot-swap** — currently fixed via subprocess fan-out (each combo runs as its own process, single Pianoid each). A future single-process implementation would require a runtime setter for `string_iteration` (currently constructor-only); that requires C++ work and a separate /dev session.
- **`pianoid.py:1317` `start_realtime_playback_unified()` hardcodes `config.audio_enabled = True`** — discovered during C-4 verification. Loading a preset with `audio_on: 0` still results in `audio_driver_active: true` because this call path overrides the Python-side `pianoid.audioOn` flag. The new tests sidestep this by passing `audio_on=False, audio_driver_type=0` at construction time, but the runtime preset switch path still has this bug. Needs a /dev session to fix.

---

## System-Wide Code Review Cleanup (2026-04-27)

**Status:** In progress — Phase 1.1 done and pushed. Phases 1.2–4 pending.

A `/review system` audit produced a categorized punch list (1 Critical / 9 High / 9 Medium / 8 Low). Full report:

- [reviews/system-review-2026-04-27.md](reviews/system-review-2026-04-27.md)

User-stated focus: structural consistency, API consistency, redundancy, dead code.

### Repo state at handoff (system restart)

All four repos are committed, pushed, and in sync with origin:

| Repo | Branch | HEAD | Notes |
|---|---|---|---|
| PianoidCore | dev | `261e865` | Merge feature/fix-volume-sensitivity-backend-init |
| PianoidBasic | dev | unchanged | (no edits this session) |
| PianoidTunner | dev | `7dd3e38` | Phase 1.1 ghost-UI removal pushed |
| PianoidInstall | master | `6b07897` | Phase 2 wrap-up archive + WIP cleanup |

WIP "Active Dev Sessions" table is empty. No outstanding locks. No unpushed commits.

### Prioritized cleanup plan

**Phase 1 — Pure deletions (low risk, high signal)**

| ID | Item | Status |
|---|---|---|
| 1.1 | Delete ghost `App.js` + dead-code closure (PianoidTunner) | **Done** — 15 files / 2677 LOC removed; 2 YELLOW C4 entries eliminated (Deck.jsx 772, Excitation.jsx 545); commit `7dd3e38`; log archived at `logs/archive/dev-ghost-ui-b8bb-2026-04-27-062035.md` |
| 1.2 | Delete `MeasureGenerator.py` (291 LOC, fully unreferenced) and inner `MeasureGenerator` class in `stringMapGenerator.py:326` | Pending |
| 1.3 | Delete checked-in `PianoidBasic/build/lib/` stale tree (20 .py files); add to `.gitignore` | Pending |
| 1.4 | Audit `TODO "TEMPORARY!!!"` rot in `pianoid.py:136, 198` — confirm no longer needed and remove | Pending |

**Phase 2 — API / structural straightening (no behavior change intended)**

| ID | Item | Notes |
|---|---|---|
| 2.1 | Rename one of the two `MeasurementEngine` classes — `auto_tuner.py:49` (offline render) → `OfflineRenderEngine`; the mic-based one in `measurement_engine.py:46` keeps the canonical name | API consistency |
| 2.2 | Resolve `/modal/apply_to_preset` signature drift between `backendServer.py:2927` (port 5000, body `{project_name, selected_chains}`) and `routes.py:853` (port 5001, body `{selected_modes}`); two parallel `ModalAdapter` instances with disk-rehydration on each call from main server | API consistency, P1 authority |
| 2.3 | Replace 4 hardcoded `http://127.0.0.1:5000/...` URLs in `components/Excitation.jsx` with the existing API base helper | API consistency |
| 2.4 | Drop `dump_coeff_tail` synonym in `parameter_manager.py:79` (N2 violation, same family as the documented `dump_ratio` bug) | Naming consistency |
| 2.5 | Decide endpoint naming convention (`/preset/list` slash-segmented vs `/load_preset` underscore-flat) and migrate stragglers | API consistency |

**Phase 3 — Layer / concern cleanup**

| ID | Item | Notes |
|---|---|---|
| 3.1 | Move PianoidBasic plotting deps (matplotlib/seaborn/librosa) out of the domain model — `chart_animation.py`, `sound_measurements.py` pull plotting deps into 6 model files (C1 layer violation) | Move to a separate dev/tools package |
| 3.2 | Pull engine lifecycle calls (`_stop_online_engine`, `_restart_online_engine`) out of `chartFunctions.py` (chart concern bleed, P2) | |
| 3.3 | Cut `chartFunctions.py:4` import from `FirFilterTest.py` (production server depending on a test file) | |

**Phase 4 — God-object splits (each its own `/dev` session, sequential, not parallel)**

| ID | File | LOC | Plan |
|---|---|---|---|
| 4.1 | `PianoidCore/pianoid_middleware/backendServer.py` | 2990 (RED, +159 vs baseline) | Split by route group |
| 4.2 | `PianoidCore/cuda_src/Pianoid.cu` | 2983 (RED, +31) | Split by phase (excitation, propagation, mode, mixing) |
| 4.3 | `PianoidCore/pianoid_middleware/pianoid.py` | 2547 (RED, +59) | Carve runtime-params + preset-IO sub-modules |
| 4.4 | `PianoidCore/pianoid_middleware/chartFunctions.py` | 2612 (RED, +23) | Split chart-render vs chart-data-fetch |
| 4.5 | `ModalAdapter` class in `pianoid_middleware/modal_adapter.py` | 2628-line class | Split by pipeline stage |
| 4.6 | `PianoidTunner/src/hooks/usePreset.js` (1516, +79) and `src/components/NumInput/NumInput.js` (1537 as of 2026-05-17 cursor-drift fix; was 1565) | RED | Split by responsibility |

Pending: dispatch order TBD by user. Phase 4 is heavy and must be triaged one file at a time.

### Open question parked at restart

Awaiting user direction: chain Phase 1.2 + 1.3 + 1.4 (all small, low-risk deletions) into one `/dev` session, or hold and dispatch each individually. Last Telegram message: msg id 1317.

---

## Cycle Profiling Harness

**Location:** `PianoidCore/tests/system/cycle_profile.py`
**Config:** `PianoidCore/tests/system/configs/cycle_baseline.json`

Measures per-stage cycle timing under configurable iter / mode (idle vs playing) / preset / driver. Captures Stage A (synthesis kernel + device sync), Stage B (regime output: D2H + driver push), and full cycle via `initTimeRecord`/`getTimeRecord` + `getCallbackStats`. Output: JSON with median / p95 / p99 / max per stage plus underrun rate.

Invoke:

    cd PianoidCore
    .venv/Scripts/python tests/system/cycle_profile.py \
        --config tests/system/configs/cycle_baseline.json \
        --output /tmp/cycle.json

Flags: `--iter`, `--mode {idle|playing}`, `--preset`, `--driver`, `--buffer`, `--duration` (override config); `--matrix` (run 2×2 iter×mode); `--downsample-6to5` (opt-in adapter for pre-fac66cb binaries with NUM_BASE_LEVELS=5).

**Findings (2026-04-22):**
- IversPond_128modes iter=8 idle SDL3: Stage A median ~780 μs across ee068dd (Mar 31) through HEAD — no kernel regression post-Volume-Calibration.
- 2×2 matrix reveals mode-count-dependent active-cycle cost: Belarus_196modes shows +444 μs per active cycle vs idle; IversPond_128modes does not.

**Note (2026-04-24):** The 780 μs / +444 μs figures above were captured against PianoidCore post-`5137240` binary AND PianoidBasic post-`83ac75d` `Mode.py`. The `83ac75d` commit (`PianoidBasic/Pianoid/Mode.py` 3-tuple `pack_modes`) was missing from `origin/dev` until 2026-04-24 — clean rebuilds during that window failed with `mode_state.size() = 1120 > 768` because pre-`83ac75d` `Mode.py` emitted 5-tuple SoA. If you cannot reproduce these timing numbers, verify `git -C PianoidBasic cat-file -t 83ac75d` succeeds locally (and that `Pianoid 0.1.13` is reinstalled into `PianoidCore/.venv/` after pulling).

### Test Environment

Cycle profiling timings are sensitive to hardware (GPU model/clock, CPU IPC, memory speed) and software stack state (CUDA toolkit, driver, MSVC, OS build). Every future profiling run **must** record the host environment so cross-machine comparisons are meaningful.

**Required fields for every profiling report:**

| Field | Capture command (Windows) |
|---|---|
| CPU model, cores, threads, base clock | `Get-CimInstance Win32_Processor \| Select Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed` |
| RAM total + speed | `Get-CimInstance Win32_PhysicalMemory \| Select Manufacturer, Capacity, Speed, PartNumber` |
| GPU model, VRAM, driver, compute cap | `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv` |
| NVIDIA driver / CUDA runtime | `nvidia-smi` (header line: `Driver Version: X.Y` / `CUDA Version: A.B`) |
| CUDA toolkit (build-time) | `nvcc --version` |
| OS + build | `Get-CimInstance Win32_OperatingSystem \| Select Caption, Version, BuildNumber` |
| MSVC version | `ls "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/"` |
| Python version | `<venv>/Scripts/python --version` |
| Disk where venv lives | `Get-Partition -DriveLetter X \| Get-Disk \| Select FriendlyName, BusType, MediaType` |
| Date of measurement | ISO 8601 date |

**Baseline entries:**

| Field | 2026-04-25 baseline (this host) | Apr 22 reference system |
|---|---|---|
| CPU | Intel Core i7-9700F @ 3.0 GHz, 8 cores / 8 threads (no SMT) | not recorded |
| RAM | 32 GB DDR4-2400 (2 × 16 GB Kingston KF3600C16D4/16GX, running 2400 MT/s) | not recorded |
| GPU | NVIDIA GeForce RTX 4070 SUPER, 12 GB GDDR6X | not recorded |
| GPU compute capability | 8.9 (Ada Lovelace) | inferred ∈ {8.0, 8.6, 8.9} (per `build_config.json` `cuda_arch_list`) |
| NVIDIA driver | 560.94 | not recorded |
| CUDA runtime (driver-side) | 12.6 | not recorded |
| CUDA toolkit (build-side) | 12.6.20 (`nvcc` built 2024-06-14) | likely 12.x (`build_config.json` structure) |
| OS | Microsoft Windows 10 Pro 64-bit, build 19045 | Windows (inferred from log usage of `taskkill`, `cmd //c`, `.bat`) |
| MSVC | VS2022 BuildTools, VC Tools 14.44.35207 | not recorded |
| Python | 3.12.0 | 3.12 (inferred from venv layout) |
| Venv disk | tigo SSD 120G (SATA SSD) | not recorded |
| Other disks | Crucial CT240BX500SSD1 (SATA), FIKWOT FN501 Pro 256GB (NVMe) | n/a |
| Measurement date | 2026-04-25 | 2026-04-22 |

**Note:** The Apr 22 reference system's hardware specs are not recorded in any archived agent log (searched `dev-ab-d2h`, `dev-volume-iter-fix`, `dev-perftest`, `dev-f5-stream`, `dev-paramsync`). Future profiling sessions should capture the full required-fields table before reporting timing data, so that absolute numbers (not just relative deltas) become comparable across machines. Without hardware data, a 30–35 % Stage A median delta between two systems cannot be classified as code regression vs hardware difference.

Consolidates prior ad-hoc probes formerly kept under `/tmp/test_cycle_*`.

---

## Known Follow-Ups

- **`play_note_offline_chart_function` — missing `get_string_indices`.** The chart function calls `pianoid.get_string_indices(pitch)` (chartFunctions.py ~line 1529), which does not exist on `Pianoid`. The surrounding try/except swallows the `AttributeError` and leaves `string_oscillation_data = (0, 0)`. Effect: String Osc Max/RMS always display 0 in the note_playback chart. Found during dev-63c2 fix; left out of scope by orchestrator. Likely replacement: `pianoid.sm.get_string_indices(pitch)` or a similar StringMap API — needs a brief code audit before fix.

- **Secondary iter-dependence in spectrum/HF/decay** (2026-04-23, post-volume-iter fix). Peak magnitude is iter-invariant after `dev-volume-iter-fix` (coeff_force dt² fix + preset rescale). However HF content increases ~25dB from iter=4 to iter=12, spectral centroid doubles (1340 → 2687 Hz), init/sust decay rates vary. Likely root cause: `coeff_frequency_decay` (Kernels.cu:139) needs iter compensation. Out of scope for the volume-bug fix. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Secondary issue".

- **pip install returns stale pianoidCuda.pyd** (2026-04-23 discovery). `pip install --force-reinstall --no-cache-dir pianoid_cuda/` silently produces cached pyd despite fresh .obj compilation. Workaround: always use `./build_pianoid_cuda.bat --heavy --release` (does full clean + pip cache purge). Structural fix would identify the caching layer in setup.py / pip build isolation. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Build pipeline discovery".

### Calibration bisection-path audit (deferred)

The factor-space clamp fix (dev-cal-clamp-fix, 2026-04-26) addresses the direct-correction paths in `synthesis_tuner.py` (`_synthesis_correct_once`) and `acoustic_tuner.py` (`acoustic_tune`). The bisection paths in `calibration_controller.py` (`_direct_correct_to_target` at ~line 1060, plus probe-update sites at ~723, ~1160, ~1186) ALSO clamp probe values in absolute-mean space [0.001, 50]. Likely break for any preset with realistic large coefficients. Audit and fix in a future task.

### Calibration REST observability gaps (deferred)

End-to-end verification of calibration writes via REST is blocked by two pre-existing bugs (discovered during dev-cal-clamp-fix verification, 2026-04-26):

- `/get_parameter/gauss_full/{pitch}` reads from cached `excitation.curves` GaussCurve objects via `to_dict()`; `_apply_single_correction` and `_set_amplitude_scale` mutate `levels_matrix` directly. UI reads stale values post-calibration.
- `/pause_synthesis` transitions state machine to PAUSED but C++ main loop continues spinning. `/synthesis_measure` then fails with "Cannot render offline: Main loop is active".

Either bug should be addressed before live UI verification of calibration is reliable.

---

## WebSocket Migration — Hybrid REST + Socket.IO

**Status:** Complete. Merged and pushed (2026-04-11). All 4 phases shipped.

Flask-SocketIO backend + socket.io-client frontend. Note playback via WebSocket with REST fallback, lifecycle push events (replace health polling), calibration progress push, MIDI playback push, engine error push, **parameter updates via WebSocket** (all 8 debounced write paths: string, mode, excitation, feedin, feedback, sound channel, volume, deck feedback). Debounce reduced from 300ms to 50ms when WS connected. `param_ack` events returned to client. Independent fixes: print() gated behind PIANOID_DEBUG_PLAY env var, deduplication added to unified play path, `_map_feedback_to_coefficient()` helper extracted.

Tests: 30/30 pass (20 unit in `test_websocket.py`, 10 integration in `test_websocket_integration.py`).

See [WEBSOCKET_MIGRATION_ANALYSIS.md](archive/WEBSOCKET_MIGRATION_ANALYSIS.md) for full analysis and implementation details.

---

## Preset System Revision — Per-Preset Runtime State & Complete Switch (SUPERSEDED 2026-05-18)

**Status:** SUPERSEDED by the Preset Working-Copy Model (dev-bfe2, 2026-05-18).
The per-preset `runtime` dict design below was the original proposal; the
user instead chose **global library-wide** volume/feedback. The revalidation
review confirmed `switch_preset` already snapshots/restores volume/feedback,
so "global" aligned with current behaviour and no per-preset `runtime` dict
was needed. The still-valid quick wins (the missing `getAvailableNotes()`
after switch, the `switchingRef` concurrency guard) were folded into the
working-copy task and implemented. See
[`docs/proposals/preset-working-copy-model-2026-05-17.md`](../proposals/preset-working-copy-model-2026-05-17.md)
(the superseding proposal) and the archived original at
[`docs/proposals/archive/preset-system-revision-plan-2026-04-09.md`](../proposals/archive/preset-system-revision-plan-2026-04-09.md).

Volume and feedback are global runtime parameters that persist across preset switches — switching from a loud preset A to quiet B and back loses A's volume/feedback settings. Additionally, available notes are not refreshed after switch (stale keyboard), the frontend MIDI feedback slider position is lost (lossy reverse mapping from coefficient), and rapid `[`/`]` key presses can interleave switch requests.

The original fix added a `runtime` dict to each `_library_models[name]` entry (backend-authoritative), saved/restored `RuntimeParameters` during `switch_preset()`, enriched the `/preset/switch` response with volume/feedback/sensitivity values, and updated the frontend to consume these values and refresh available notes. **This per-preset design was dropped** — see the superseded status above.

**Sound-channel cache silence on preset switch — resolved (2026-04-20, Wave B).** Independent of the planned runtime-state work, preset transitions could silence Strings mode because in-flight debounced `changeSoundChannelValues` / `changeSoundChannelFeedback` writes from the outgoing preset resolved after the refetch and merged stale pitch keys back via `setSoundChannelData(prev => ...)`. Fixed by clearing `soundChannelData` + `soundChannelFeedbackMatrix` to `null` at the top of `loadPreset()` and `switchPreset()` in `usePreset.js`, before the async refetch.

**Sound Channels strings-axis tooltip null + bulk-edit no-op — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing bug surfaced after Wave D manual testing. In strings axis, the matrix from `/get_parameter/feedback/output` uses backend output-pitch keys (`"128".."128+N-1"`) while `availableOutputChanels` exposes the shifted `[0..N-1]`. All downstream consumers (canvas hover lookup, `useMatrixHistory.calcChange`, Workbench) indexed by the shifted frontend channel, producing undefined lookups → tooltip rendered `Value: null`, and the pitch-key guard in `calcChange` silently no-op'd Cell/modesVector/modesVectorDrawn edits. Row and column bulk edits in strings axis never reached the backend. Fixed in `useSoundChannels.js` by normalizing strings-axis keys on init (strip 128) and denormalizing on emit (restore 128), so the canvas/history/workbench stay axis-agnostic while the network payload preserves the backend convention. Verified end-to-end: tooltip now shows real values, row/col bulk edit mutates the matrix, modes axis unchanged.

**useMatrixHistory undo crash on rapid edits — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing P1-violation latent since the hook was written. `recordChange` used a stale closure for `currentStep` when slicing the history array — in a burst of clicks within one React batch, every call saw the same captured `currentStep`, so `setHistory(prev => [...prev.slice(0, currentStep), change])` produced only one entry (last-write-wins), while `setCurrentStep(prev => prev + 1)` correctly advanced per-call via its functional updater. `currentStep > history.length` left holes; `restoreMatrixAtStep(step-1)` walked past the end → `entry.operation` on undefined → crash. Surfaced only after the strings-axis fix enabled edits that previously no-op'd silently. Fixed by adding `stepRef = useRef(0)` as the synchronous slice-boundary source of truth — read and bumped inside `recordChange` before the setState calls, so per-call boundaries are correct even without rerender. `init`, `restoreMatrixAtStep`, `undo`, `redo` all synchronized via the ref. Defensive clamp in `restoreMatrixAtStep` (`Math.min(step, history.length)` + skip undefined entries) so a future desync cannot crash. Verified: 5-click burst now produces step=len=6 (was step=6/len=2 before), undo/redo cycle through all steps without error, truncation-after-undo works. Applies to all matrix-history consumers (strings/modes SC, feedin, feedback, strings params, modes params, excitation).

The archived original analysis is at
[`docs/proposals/archive/preset-system-revision-plan-2026-04-09.md`](../proposals/archive/preset-system-revision-plan-2026-04-09.md);
the implemented superseding design is
[`docs/proposals/preset-working-copy-model-2026-05-17.md`](../proposals/preset-working-copy-model-2026-05-17.md).

**Files that were modified (working-copy task, dev-bfe2):**
- `PianoidCore/pianoid_middleware/pianoid.py` — `switch_preset()`, `load_preset_to_library()`, `init_pianoid()`, `spawn_working_copy()`, `promote_working_copy()`, `_assert_active_editable()`
- `PianoidCore/pianoid_middleware/preset_library.py` — new `PresetLibrary` registry class
- `PianoidCore/pianoid_middleware/backendServer.py` — `/preset/*` working-copy endpoints, `preset_read_only` 409 mapping
- `PianoidTunner/src/hooks/usePreset.js` — library records, `spawnWorkingCopy`/`promoteWorkingCopy`, `getAvailableNotes()` after switch, `switchingRef` concurrency guard

---

## NumInput Bidirectional Data Flow — Cursor Drift on Rapid Stepping (CLOSED 2026-05-17)

**Status:** CLOSED. The cursor-drift open issue was resolved by `dev-cursor-drift`
on PianoidTunner branch `feature/cursor-drift-fix` (2026-05-17): the three
competing caret-restore mechanisms were collapsed to the single `useLayoutEffect`,
and digit-anchored exponent-caret math (`anchorExponentCaret`) was added so an
exponent digit rollover no longer drifts the caret. Regression coverage:
`PianoidTunner/src/components/__tests__/numinput-cursor.test.jsx` (5 tests).

The earlier bidirectional-data-flow stabilization (`feature/fix-bidirectional-input`)
is long since merged to `dev`. See
[DIGITAL_INPUT_ANALYSIS.md](DIGITAL_INPUT_ANALYSIS.md) (reconciled 2026-05-17) for
the full record.

---

## C++ Logging Migration

**Status:** Session 1 complete. Remaining files pending.

Replaced all `printf`/`cout`/`cerr` in hot-path and core C++ files with `PianoidLogger` file-based logging. Three hot-path statements fixed (cycle-level `std::cout` in `Pianoid.cu`, per-callback `printf` in `SDL3AudioDriver.cpp`, warmup `cout` in `CycleTimeEstimator.cu`).

See [LOGGING.md](../modules/pianoid-cuda/LOGGING.md) for full details and migration status.

| Scope | Status |
|-------|--------|
| PianoidLogger infrastructure | Done |
| Hot-path fixes (3 locations) | Done |
| Core C++ files (~175 statements in 8 files) | Done |
| pybind11 bindings + Python lifecycle | Done |
| Remaining C++ files (~75 statements) | Pending |
| Python print migration (578 statements) | Planned |
| `backendServer.py:475` hot-path `print` → `logger.debug` | Done (dev-bprint, 2026-04-20) |
| `backendServer.py` other request-handler prints (~80 calls across `/set_parameter`, volume, feedback, play, MIDI) | Pending — latent: same break mode if stdout pipe fails, now shielded by global errorhandler (returns JSON 500 with CORS) but still produce empty responses; best migrated to `logger` in the planned sweep |

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** F5 landed (2026-04-22, dev-f5-stream) but measured **no effect** on underrun rate. Investigation continues — compute-bound, not serialization-bound.

Two concerns were identified pre-F5:

1. **Lock-scope window (pre-existing, latent).** `produce()` releases its mutex before the D→H copy, creating a ~0.5–1.3 ms window where `consume()` can see a stale `write_position`. Not addressed by F5.

2. **Default-stream serialization (F5 hypothesis, refuted by data).** `produce()` used default-stream `cudaMemcpy` + `cudaDeviceSynchronize`. Hypothesis: this implicitly serialised the D→H copy against the synthesis kernel (also on default stream), doubling pipeline depth and turning jitter into underruns. F5 moved produce() to a dedicated `cudaStream_t produce_stream` with `cudaMemcpyAsync` + `cudaStreamSynchronize`. **The A/B data below show this had no observable effect.**

**F5 A/B measurement** (silent-engine probe, SDL3, Preset_test5, `buffer_size=4`, 30 s). Same-harness: revert F5 → rebuild → measure → restore F5 → rebuild → measure.

| Config | Pre-F5 | Post-F5 | Δ |
|--------|--------|---------|---|
| `string_iteration=8` | 33.3% underrun, 13 975 µs max | 33.4–35.0% underrun, 16 311–18 123 µs max | within noise |
| `string_iteration=12` | 110.9% underrun, 18 501 µs max | 110.3% underrun, 21 031 µs max | within noise |

The initial report of "~100% → 33.4%" was a cross-load comparison error — the ~100% came from an analyse-distortion A1 run whose `string_iterations` kwarg (plural) silently dropped and ran at default iter=12, not iter=8. After correction, same-harness A/B shows **no F5 effect** at either load level.

F5 is **kept** on correctness grounds (producer copy should not implicitly block on unrelated default-stream GPU work), but is **not the fix** for distortion. The real lever is synthesis kernel cost (iter=12: 110% = kernel over budget; iter=8: 33% = kernel near budget, OS scheduling tips it over).

See [logs/dev-f5-stream-2026-04-22-163903.md](logs/dev-f5-stream-2026-04-22-163903.md) for the full A/B and [probe_f5_silent_engine.py](../../PianoidCore/tests/system/probe_f5_silent_engine.py) for reproduction (env vars `F5_STRING_ITER`, `F5_DURATION_S`).

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | In progress — serialization refuted, compute-bound hypothesis remains |
| F5 — dedicated CUDA stream for produce() | Merged, no underrun effect (dev-f5-stream) |
| Fix `produce()` lock scope | Pending (distinct concern; F5 null result suggests it's also not load-bearing) |
| Reduce synthesis kernel cost at high `string_iteration` | Pending — now the primary lever |
| Investigate SDL3 callback jitter (300 µs stddev, 18 ms max on 10 ms cadence) | Pending — OS-scheduling hypothesis |

See [Testing](TESTING.md) for the test inventory.

---

## Interactive Stabilization Diagram — Chain Editing & Visualization

**Status:** All phases complete (Phase 1–5) + UI refactoring (2026-04-11).

See [INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md](archive/INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md) for full architecture decisions, 5-phase implementation plan, and risk analysis.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Zoom/pan, brush selection, chain paths, bidirectional sync, visual encoding, damping toggle | Done |
| 2 | `save_edited_chains()` + `POST /modal/chains/save` | Done |
| 3 | `useChainEditor` hook + `StabilizationToolbar` + `StabilizationDiagram` extraction + `saveEditedChains` in useModalAdapter | Done |
| 4 | Interactive chart editing (mode-dependent handlers) | Done |
| 5 | Polish: unassigned detections, keyboard shortcuts, validation, performance, feedin guard | Done |
| Refactor | ESPRIT-only view, chain toggle fix, selection highlighting, rectangle zoom, damping/amplitude viz | Done |

**Refactoring changes (2026-04-11):**
- Diagram shows ESPRIT extraction data (unassigned dots) even before tracking runs
- Chain path toggle (showPaths) fixed — no longer sticks in "on" state
- Chain selection: default no selection; selected chains have white border + blue glow + larger size; unselect clears all visual emphasis
- Rectangle zoom: brush selection in select mode zooms to area; "Reset Zoom" button restores full view
- Damping overlay removed. Replaced with: (1) heatmap mode (D/A buttons) color-codes points by damping or amplitude, (2) sub-chart below main chart (Damp/Amp/Both) showing line charts for selected chains sharing X-axis

**Sub-chart data fix (2026-04-12):**
- Amplitude/shape/MAC sub-charts showed empty when loading existing projects (chains.json lacked amplitude/shape data saved before the feature was added)
- Fix: `_enrich_chains_from_esprit()` in `modal_adapter.py` back-fills amplitude and shape from ESPRIT per_scenario_results into chain detections on load, then persists enriched chains to disk

**Reference projection sub-chart (2026-04-12):**
- New "Proj" toggle button alongside Damp/Amp/MAC/Shape
- Computes signed reference projection from complex mode shapes in frontend: mean shape as reference, Re(dot(shape, conj(ref))) per detection
- X=scenario (zoom-synced with main diagram), Y=signed scalar (+in-phase / -anti-phase)
- Zero reference line marks nodal boundary, area fill highlights positive/negative regions

**Selected chain properties display (2026-04-14):**
- When chains are selected, MUI Chips appear above the main chart showing per-chain: ID, mean frequency (Hz), mean damping ratio, scenario count
- Chips bordered by stability color (green/yellow/orange/grey) for quick identification
- Compact and non-intrusive — wraps across multiple rows when many chains selected

**Visualization enhancements (2026-04-14):**
- Bridge boundary: replaced inaccurate graphic percentage line with ECharts markLine at exact scenario index, tracks zoom/pan, "Bass | Treble" label
- Chain visibility filter: ToggleButtonGroup (Stable / +Semi / All / Unasgn) filters chains by stability class; "Unasgn" hides all chains and shows only orphan detections (larger, orange)
- Chain paths visible by default (`showPaths` initialized to `true`)
- Chain selection fix: brush tool was intercepting clicks before scatter handler; tiny brush areas now detected and converted to click-select via `findNearestChain`
- Full-bridge chains (`bridge="full"`): path lines split at `bridgeBoundary` to show natural gap between bass/treble sections
- Interactive shape sub-chart: clicking selects ALL lines crossing the click area (5% Y-range tolerance), not just the single clicked line; all corresponding points highlighted on main chart (white diamond, orange glow); non-matching shape lines dim; toggleable
- Zoom fixes: brush rectangle artifact cleared via brush tool toggle off/on; reset zoom also dispatches `dataZoom` reset to 0-100% on both axes
- Shape phase alignment: scenario shapes normalized to consistent phase before display — dot product with reference shape determines sign flip, so shapes from different scenarios are visually comparable

**Zoom system refactoring (2026-04-14):**
- Unified dual-state zoom: removed ECharts `dataZoom` (type "inside") components; all zoom now flows through single `viewBounds` React state
- Manual scroll-wheel zoom: cursor-centered, log-aware for Y axis (frequency), replaces ECharts internal scroll/pinch zoom
- Reset Zoom button visible whenever any zoom source is active (not just brush zoom)
- Centralized brush lifecycle: single effect manages brush arm/disarm via `brushGeneration` counter, replacing 3 competing paths (handleBrushSelected cleanup, useEffect on option change, handleChartReady)
- Sub-charts sync with unified zoom state via `viewBounds`
- All chart animations disabled (`animation: false`) — ECharts axis interpolation caused visible intermediate state on zoom reset

**Bug 4 — interactive shape anchor for phase + magnitude alignment (2026-04-19, dev-190d):**
- Shape sub-chart ("shape across channels" mode) displayed unphased, unscaled curves. Existing `alignShape` helper phased scenarios within a SINGLE chain against that chain's own first detection, but different chains referenced different anchors and magnitudes varied wildly — so overlaid curves had no common visual reference and were not indicative.
- First attempt (auto-minimax): picked anchor channel automatically as argmax over channels of min |value| across curves. Rejected by user on redesign — the "best" channel in a noise sense may not be the one the user wants to compare at, and aggressive normalization without consent hides the raw spatial pattern when it's the useful view.
- Final implementation (user-driven anchor):
  - New local state `shapeAnchor: null | channel_index` (null = raw unphased, integer = normalize to +1 at that channel). Default null.
  - `useEffect` resets `shapeAnchor` to null whenever Shape sub-chart is toggled off, so re-enable always starts in raw mode.
  - In the `subChartData` useMemo: scenario-level `alignShape` runs unconditionally as before (no regression of prior fix); cross-curve normalization is applied ONLY when `effectiveShapeAnchor != null` (clamped to valid channel range). For each curve, multiplier = `1 / curve[anchor]` so curve passes through +1 at the anchor. Guard: curves with `|curve[anchor]| < 1e-12` are left untouched (no division by zero).
  - UI: above the Shape sub-chart, a compact `ToggleButtonGroup` lists channel numbers (0..nCh-1) plus an "OFF" button. Clicking a channel number sets the anchor; clicking another re-anchors instantly (re-triggers the useMemo via the `shapeAnchor` dep); clicking OFF clears back to raw view. OFF is disabled when no anchor is active.
  - `makeShapeSubOption` gates the dashed vertical markLine and the `"Shape (norm @ Ch<N>)"` Y-axis label behind `anchorChannel != null` — both disappear in raw mode.
  - Click-to-highlight handler on the sub-chart is unchanged: it operates on whatever `shapeSeries` it receives, so it works in both raw and normalized modes (tolerance scales with actual Y range).
- UI verified end-to-end on Belarus8D_clean (5 response channels):
  1. Default view = raw unphased curves (Y ~ -1..1). Pass.
  2. Anchor Ch 1 / Ch 2 / Ch 3 / Ch 4 → dashed markLine appears, Y-axis label updates, curves converge at the anchor. Pass.
  3. OFF → raw view restored, markLine gone, Y-axis back to "Shape". Pass.
  4. Toggle Shape sub-chart OFF → ON → state reset to null, raw view. Pass.
  5. Single chain selected + anchor set → single curve passes through +1 at anchor. Pass.

- **Extension (same batch) — percentile-based Y clipping when anchor is active:** user reported that outlier chains (chains with near-zero at the anchor) stretched the Y range to ±thousands, jamming the readable curve body near 0.
  - Added Y clip inside `makeShapeSubOption`: collect all y-values from `shapeSeries`, sort, take 5th/95th percentile, pad by 10% of the clipped range, then round to nice tick boundaries (`niceRound` helper — 0.5*10^mag steps). Always keep +1 inside the visible range so the anchor markLine remains meaningful.
  - Min-samples guard: `< 20` total values → fall back to auto-range (small sample percentile is unreliable).
  - Explicit `min: null, max: null` when anchor is off — ECharts merges yAxis options rather than replacing them, so without explicit nulls the previous clip bounds would persist after clearing the anchor (caught during UI test).
  - Raw mode (anchor null) keeps ECharts auto-range. Tooltips still show real numeric values (ECharts axis-trigger uses series data, not clipped pixels).
  - Verified visually on Belarus8D_clean (5 chains, Ch 0 anchor): before fix Y range was roughly -12000..3000 (curves invisible); after fix Y range is -4..4 (curves clearly readable, outliers run off-chart). Same Ch 0 anchor on single chain gives Y range -3..1.5. All other channels (Ch 1/2/3/4) behave similarly — readable curve body, outlier curves clip off.
  - Console: 0 new errors. Pre-existing ModalAdapter "Invalid prop children" warning and WebSocket reconnect errors on :5000 are unrelated.

**Bug 2 — brush rectangle persistence fix (2026-04-19, dev-9d5c):**
- Blue brush rectangle sometimes persisted on screen after zoom. Root cause: the clear-brush dispatch in `handleBrushSelected` lived inside the outer try and AFTER the data-path `return` statements, so any early return (unrecognized coordRange shape, pixel-conversion failure) or exception in processing (chainEditor race, NaN in geometric mean) swallowed the clear and left the rectangle visible.
- Fix (first pass): wrapped `handleBrushSelected` body in try/finally so `dispatchAction({type:"brush", areas:[]})` + `setBrushGeneration++` run on every exit path. Also added defensive `dispatchAction({type:"brush", areas:[]})` at the top of the centralized brush lifecycle effect.
- Regression (same day): first-pass fix caused a 300ms-period infinite feedback loop. `dispatchAction({type:"brush", areas:[]})` triggers the ECharts `brushVisual` pipeline which queues a throttled `brushselected` event via `visualEncoding.js:189`. The finally block's clear dispatch AND the lifecycle effect's defensive clear both produced echoes; the echo entered `handleBrushSelected` with empty areas; the inner empty-areas `return` was inside the try so the finally ran anyway, bumping generation and re-dispatching — continuous redraw of the chart region. Measured before fix: 7 brushselected fires in 2s idle.
- Fix (second pass, Option C — echo guard + single-owner clear):
  1. Added an echo guard at the very top of `handleBrushSelected`: if `params.batch[0].areas` is empty, return BEFORE the try/finally. Real user brush events always carry non-empty areas; empty-areas events are ECharts echoes or legitimate no-op clears with nothing to act on.
  2. Removed the defensive `dispatchAction({type:"brush", areas:[]})` from the lifecycle effect. The finally block in `handleBrushSelected` is the single owner of the brush clear — removing the second path eliminates a second feedback source.
- Second regression (same day, worse than first pass): user reported "rectangle persists more than before." DOM-level instrumentation (60 Hz sampler on zrender display list + `BrushController._covers / _creatingCover / _dragging`) with a real mouse-drag repro revealed a new failure mode: during a drag with a mid-drag pause (>300ms), `brushselected` fires DURING the drag. Our handler runs, dispatches `brush areas:[]`. ECharts `BrushController.updateCovers([])` at BrushController.js:189-225 empties `_covers` immediately (line 198: `this._covers = []`), but the DataDiffer `remove(oldIndex)` callback guards at line 221: `if (oldCovers[oldIndex] !== creatingCover) group.remove(...)`. When `_creatingCover` is still set (drag ongoing), `group.remove` is SKIPPED — the zrender cover element is ORPHANED (not in `_covers`, but still in `group.children()`, still rendered). After mouseup, no subsequent dispatch reaches `group.remove` for the orphan: `handleDragEnd`'s internal `brush` dispatch has `$from: modelId` which is rejected by `BrushView._updateController`'s anti-echo guard, and our echo-guard brushselected returns without dispatching. Orphan persists indefinitely.
- Fix (third pass, Option D — direct group reconciliation): added `forceRemoveOrphanedCovers()` helper that walks `inst._componentsViews -> brush view -> _brushController`, computes `Set(_covers)`, and directly removes any `group.children()` entry not tracked in `_covers`, then calls `zr.refresh()`. This bypasses DataDiffer's `_creatingCover` guard. Called from three sites: (a) echo path at top of `handleBrushSelected` (post-drag cleanup), (b) finally block after the clear dispatch (happy path belt-and-suspenders), (c) end of the lifecycle effect (safety net after mode/generation change). Feedback-loop safety unchanged — echo guard still prevents infinite re-entry.
- Verification post-third-pass: 0 brushselected fires in 5s idle. All scenarios pass with DOM-level confirmation (`groupChildren: 0, ctrlCovers: 0, visibleCovers: 0`): happy path smooth drag, tiny-click isSmall path, mid-drag-pause (the exact user repro), 4 rapid successive drags, mode toggle off->on.

---

## Modal Adapter Redesign — Phase 1 + Phase 2 + Phase 3

**Status:** All implementation complete (2026-04-06 to 2026-04-09). Browser verification pending.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](archive/MODAL_ADAPTER_REDESIGN_PLAN.md) for full plan, commit references, and architecture details.

### Phase 1: Independent Stages + Full Pipeline (6 waves)

Replaces sequential `AdapterState` enum with data-availability checks, per-section "Load Saved" buttons, "Run Full Pipeline" with Stepper progress.

| Wave | Scope | Status |
|------|-------|--------|
| 1 | State machine removal + data checks + ModeChain reconstruction | Done |
| 2 | Measurement persistence + ESPRIT refactor + pipeline method | Done |
| 3 | Offline preset builder (`build_preset_to_file`) | Done |
| 4 | New API endpoints (`GET /modal/data_status`, `POST /modal/run_pipeline`) | Done |
| 5 | Frontend hook (`useModalAdapter` — `dataStatus`, `canRun*` flags, `runPipeline`, `loadIntermediate`) | Done |
| 6 | Frontend UI (`ModalAdapter.jsx` — data-driven enablement, pipeline controls) | Done |

### Phase 2: Server Separation, Projects & UI Overhaul (2026-04-08/09)

| Feature | Commits | Status |
|---------|---------|--------|
| Separate modal adapter server (port 5001, `threaded=False`) | `8fd1226` | Done |
| Project management system (7 CRUD endpoints, project.json storage) | `8fd1226` | Done |
| Synthesis pause/resume (`/pause_synthesis`, `/resume_synthesis`) | `8fd1226` | Done |
| ESPRIT fixes (`_resolve_bands`, null `window_length`, numpy serialization) | `8fd1226` | Done |
| FolderBrowser component (native OS folder picker via tkinter) | `2e55e80` | Done |
| Frontend tab UI (Project/ESPRIT/Tracking/Apply replacing accordions) | `020dbd7` | Done (superseded by Phase 3 toolbar) |
| Per-scenario ESPRIT with checkbox selection + shift-click | `020dbd7` | Done |
| EspritConfig simplification (GPU checkbox + advanced toggle) | `020dbd7` | Done |
| Dual-process launcher (port 5000 + 5001 management) | `020dbd7` | Done |

### Phase 3: Toolbar UI (2026-04-09)

Replaced tab navigation with a compact single-row toolbar: server status chip, project button, pipeline ButtonGroup (ESPRIT/Tracking/Apply with checkmark/spinner status), gear icon for collapsible context-sensitive settings, and play/skip-next buttons (with stop when running). Settings and run buttons removed from section bodies.

| Feature | Status |
|---------|--------|
| Toolbar with pipeline ButtonGroup | Done |
| Server status chip (On/Off, clickable) | Done |
| Project button with name + checkmark | Done (merged into Setup button) |
| Context-sensitive settings panel (gear toggle) | Done |
| Play (run step) + SkipNext (run to end) buttons | Done |
| Stop button overlay when running | Done |

### Phase 4: Merged Setup Panel + Settings Freeze (2026-04-12)

Merged Project and ESPRIT into a unified "Setup" section. Channel roles and ESPRIT config moved to settings/gear panel. All settings freeze (disabled + lock icon) once ESPRIT processing starts.

| Feature | Status |
|---------|--------|
| Merge Project + ESPRIT into unified Setup section | Done |
| Channel roles in settings/gear panel (not section body) | Done |
| ESPRIT config in settings/gear panel alongside channel roles | Done |
| Settings freeze when ESPRIT starts (running or done) | Done |
| Lock icon replaces gear icon when frozen | Done |
| Project creation/import/copy/delete hidden when frozen | Done |
| Setup button shows project name | Done |

### State Management Rewrite (2026-04-13)

Phased elimination of split-brain state between frontend and backend.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Backend `GET /modal/project_state` endpoint | Done |
| 2 | Backend `DEFAULT_CONFIG.preset` → `extended_8band` | Done |
| 3 | Frontend `mappingDirty` tracking for explicit save | Done |
| 4 | Frontend `syncFromBackend()` — single state sync function | Done |
| 5 | Frontend cleanup — dead code, state consolidation, log path fix | Done |

Phase 4 replaced ~200 lines of ad-hoc state restoration across `openProject`, `createProject`, `copyProject`, mount effect, and `addMeasurementsToProject` with a single `syncFromBackend()` function. Every mutation now calls `syncFromBackend()` after success. Removed dead `applyConfig`/`setConfigPreset` (endpoint deleted in Phase 1).

Phase 5 cleanup: removed `onPresetSelect` dead prop from EspritConfig, removed band-preset retry-polling (fetch once on mount instead), consolidated 4 project-related useState calls into grouped `project` state object, removed unused `pct` variable in importProject upload handler, fixed hardcoded log path in modal_adapter `__init__.py` to use system temp directory.

### Bug 3 — Settings relocation to native MosaicWindow toolbar (2026-04-19, dev-aeb0)

The custom inline gear IconButton in the ModalAdapter toolbar row was redundant with the native MosaicWindow title-bar toolbarControls slot. Fix relocates the settings gear/lock to the title bar via `ReactDOM.createPortal` into `.mosaic-window-controls`. A `useLayoutEffect` hook also hides the generic `button[title="Settings"]` that `PianoidTuner.renderToolbarControls` injects for all panes (it was pointing at an empty PropertyManager since "Modal Adapter" has no `settingsMap` entry). Net result: exactly one settings gear in the title bar, wired to ModalAdapter's real settings panel. Freeze/lock behavior preserved; all context-sensitive content (MappingEditor + EspritConfig for Setup, freq tolerance + max gap for Tracking, merge toggle + sound channel mapping for Apply) unchanged. Fully contained in `ModalAdapter.jsx` — no edit to `PianoidTuner.js` required.

### Remaining

- Browser verification of all Phase 1 + Phase 2 + Phase 3 + Phase 4 features
- Browser verification of state management rewrite (project open/create/copy, ESPRIT run, state persistence)
- Independent-stage loading, full pipeline execution, backward compatibility
- Project CRUD workflow, toolbar navigation, per-scenario ESPRIT UI

---

## Extended 8-Band Pipeline Run (2026-04-07/08)

**Status:** ESPRIT + tracking + feedin complete. Preset built, not yet volume-matched.

The `extended_8band_medium` pipeline completed all stages on Belarus piano data:
- **ESPRIT:** 78/78 scenarios, 8210 raw modes, ~56 sec/scenario, ~72 min total
- **Tracking:** 441 chains (210 stable, 133 semi-stable, 64 weak, 34 spurious)
- **Feedin:** 88 pitches (78 measured + 10 interpolated), 441 mode frequencies

A 196-mode preset (`Belarus_8band_196modes.json`) was built from the top 196 stable modes with per-mode normalized feedin (0–1 range) and per-channel output pitch feedback. The preset produces sound but is quieter than BaselineBelorus1 at higher pitches — likely due to different modal content between 4-band and 8-band extractions.

Data: `/tmp/belarus_78_extended_8band_medium/`

See [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) and [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) for run details.

Reference presets:
- `presets/BaselineBelorus1.json` (196 modes, 4-band, per-mode normalised feedin)
- `presets/Belarus_8band_196modes.json` (196 modes, 8-band medium, per-mode normalised feedin)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — legacy)

---

## note_playback Chart Auto-Normalization

**Status:** Pending fix.

`ChartData.create_audio()` in `ChartRegistry.py` normalises the WAV audio to 0.8× peak before sending to the frontend, masking silent-output bugs. The chart statistics (max, RMS) are from the raw buffer before normalisation, but the WAV IS normalised. During Belarus preset development, this masked a silent-output bug.

**Fix options:**
1. Report `synthesis_peak` (actual kernel output magnitude) alongside chart stats
2. Add a warning when synthesis_peak is below a threshold
3. Optionally disable auto-normalisation

---

## ASIO Driver Re-initialization Failure

**Status:** Pending fix.

After ASIO callback driver is stopped, re-initialization fails with "no working ASIO device found". Root cause: `AsioAudioOutput::Close()` in `AsioAudioInterface.cpp` doesn't reset global state variables (`asioDriverInfo`, `directOutputFn`, `asioCallbacks`, `queueToPlay`) and the `AsioDrivers` COM singleton is never destroyed/recreated.

**Workaround:** Restart the backend server between ASIO sessions.

---

## Completed Items (archived)

| Item | Status | Notes |
|------|--------|-------|
| Excitation API Mismatch | Fixed | `StringMap.pack_base_excitations()` added to PianoidBasic |
| Parameter Routing Unification | Complete | All routes through `ParameterManager` |
| Playback System Fixes | Complete | 11/14 findings fixed (see tracker below) |
| Microphone-Based Volume Equalization | Implemented | 4-phase calibration across all 3 repos |
| RoomResponse Modal Adapter Integration | Complete | All 4 waves, 6 critical bugs fixed |
| Sound Channel useEffect Feedback Loop | Fixed (re-fixed 2026-04-30) | Initially patched with `scDataRefresh` flag (Apr 2026, dev-sc-tooltip-rowcol). Re-fixed architecturally in dev-833f Phase C2 with the three Frontend State Discipline principles (presetVersion counter, granular per-pitch emits, imperative-at-handler writes). The `scDataRefresh` boolean is removed; consumers re-init via `[presetVersion]`. |
| Second Derivative Sound Output | Resolved | Kernel-level 2nd derivative implemented |

### Playback System — Improvement Tracker

| # | Finding | Status |
|---|---------|--------|
| 1 | Three overlapping stop methods | **Done** |
| 2 | `stop_pianoid()` sleep race condition | **Done** |
| 3 | `long_running_procedure()` dead reference | **Done** |
| 4 | MIDI→EventType mapping duplicated 3× | **Done** |
| 5 | No CUDA error check in online engine | **Done** |
| 6 | `play_mode()` blocking sleep | **Done** |
| 7-10 | Dead code cleanup | **Done** |
| 11 | Double mutex in `RealTimeEventBuffer` | **Done** |
| 14 | No playback integration tests | Pending |

---

## Recently archived

Moved to [archive/](archive/) on 2026-04-25 (`archive-dev-docs`):

| File | Reason |
|---|---|
| [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) | Primary bug fixed (Kernels.cu:155 dt² fix + preset rescale, 2026-04-23). Secondary follow-ups still tracked above under Known Follow-Ups. |
| [archive/PLAYBACK_ARCHITECTURE_REVIEW.md](archive/PLAYBACK_ARCHITECTURE_REVIEW.md) | Research snapshot (2026-04-20). Subsequent cycle orchestration tranches (C1/C2/C3/C8/C10/C11/C12/C13) committed. |
| [archive/CYCLE_ORCHESTRATION_REFINEMENT.md](archive/CYCLE_ORCHESTRATION_REFINEMENT.md) | All proposed tranches (A/B/C2/C3/F5) committed. |
| [archive/DISTORTION_INVESTIGATION_CONTEXT.md](archive/DISTORTION_INVESTIGATION_CONTEXT.md) | Briefing snapshot (2026-04-20), precursor to volume-iter — closed. Live distortion concerns now tracked under Buffer Underrun Investigation. |
| [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md](archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md) | System analysis snapshot (2026-04-06) of mic calibration; implementation listed under Completed Items. |
