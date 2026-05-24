# Local Review — Tracking-Results PDF Report Feature (dev-f116)

- **Level:** Local (per `/review` skill)
- **Date:** 2026-05-22
- **Reviewer:** review agent (read-only on source)
- **Branch:** `feature/tracking-report-pdf` (off `dev`) in PianoidCore + PianoidTunner, uncommitted
- **Author:** dev-f116 (holds locks on the 5 source files)
- **Verdict:** **SAFE TO COMMIT AS-IS.** No Critical/High findings. 1 Medium (YELLOW file size, accepted), 4 Low. The subtle heatmap-blend parity is **pixel-exact** (verified numerically, not just by passing tests).

---

## Scope

Uncommitted changes implementing a per-mode tracking-results PDF for the modal-adapter export set:

| Repo | File | Change |
|------|------|--------|
| PianoidCore | `pianoid_middleware/modal_adapter/report_generator.py` | NEW — 590 LOC, stateless `ReportGenerator` over `ProjectContext` |
| PianoidCore | `pianoid_middleware/modal_adapter/routes/project_routes.py` | +51 — `POST /modal/projects/<name>/tracking_report` route |
| PianoidCore | `pianoid_middleware/modal_adapter/modal_adapter.py` | +26 — import + instantiate + `generate_tracking_report` facade delegate |
| PianoidTunner | `src/hooks/useModalAdapter.js` | +49 — `generateTrackingReport` hook method |
| PianoidTunner | `src/modules/ModalAdapter.jsx` | +94 — "Tracking Report (PDF)" Apply-panel sub-panel |
| Tests | `PianoidCore/tests/unit/test_tracking_report.py` | NEW — 18 pass (re-run confirmed) |
| Tests | `PianoidTunner/src/hooks/__tests__/useModalAdapter.trackingReport.test.jsx` | NEW — 4 tests |

Docs (`MODAL_ADAPTER_GUIDE.md`, `REST_API.md`) updated by dev-f116 and consulted first per the documentation-first rule.

---

## 1. Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | `pianoid_middleware/modal_adapter/modal_adapter.py` | 4036 | RED (pre-existing god object; +26 here) |
| 2 | `PianoidTunner/src/hooks/useModalAdapter.js` | 1799 | RED (pre-existing; +49 here) |
| 3 | `PianoidTunner/src/modules/ModalAdapter.jsx` | 1730 | RED (pre-existing; +94 here) |
| 4 | `PianoidCore/.../routes/project_routes.py` | 610 | YELLOW (pre-existing; +51 here) |
| 5 | **`pianoid_middleware/modal_adapter/report_generator.py`** | **590** | **YELLOW (NEW — see Finding M-1)** |

> **Baseline drift note (informational, not a finding against dev-f116):** the `CODE_QUALITY.md` "Current Known God Objects" baseline is stale relative to the live tree — it lists `modal_adapter.py` at 2725, `useModalAdapter.js` at 1356, `ModalAdapter.jsx` at 1077 and `project_routes.py` is absent. Actual LOC are 4036 / 1799 / 1730 / 610. These files grew through other branches (the table itself notes Wave-1 of the modal-adapter split). dev-f116 did **not** create any new RED file and added only thin, idiomatic increments to the three already-RED files (see §C4 assessment below). The baseline table should be regenerated at the next `system`-level review.

---

## 2. Architectural Consistency

**Layer audit: PASS.** The feature lives entirely in the modal-adapter middleware (port 5001) and the frontend. `report_generator.py` is pure read-only computation/rendering over `ProjectContext` — no I/O beyond writing its own PDF, no HTTP, no engine calls. The route is validate → process → respond, mirroring `export_text_files_route`. The frontend hook is REST-only; the component holds local UI state (`reportBusy`/`reportResult`) — no business logic, no authoritative state. Correct 4-layer separation.

**Server audit: PASS.** Lands on the modal adapter (5001). `report_generator.py` imports only sibling modal-adapter modules (`ProjectContext`, `VisualizationService` — both via `TYPE_CHECKING`) and matplotlib/numpy. No `import backendServer` / `pianoid` / `parameter_manager` (C2 dual-server rule respected). The frontend hook calls the modal-adapter port directly — no main-server proxy.

**C4.1 Facade-policy audit: PASS.** `ModalAdapter.generate_tracking_report` (modal_adapter.py:3945-3960) is a pure 3-line delegation body (`return self._report_generator.generate_report(...)`) with no business logic — exactly the "REST-shape delegation method" exception the post-Wave-1 facade policy permits. New logic correctly went into a new focused module (`report_generator.py`), NOT into the 4036-LOC `modal_adapter.py` god object. This is the right call and matches the dev log's stated intent.

---

## 3. Authority Violations (P1)

| # | State | Owner | Violating Writer | Severity |
|---|-------|-------|------------------|----------|
| — | None | — | — | — |

`ReportGenerator` is stateless: it stores only `self._ctx` and `self._viz` (injected references) and **reads** `ctx.tracked_chains`, `ctx.mapping`, `ctx.project_dir`, `ctx.current_project`. Per `project_context.py` ownership comments these are owned by `TrackingOrchestrator` / `ProjectStore`; the report generator is a read-only consumer exactly like `VisualizationService` (Wave-1 split). It writes only the output PDF file (not shared state). The export set is **not** persisted — it arrives as `selected_chains` in the POST body, identical to the `export_text` authority model. No new source of truth, no multi-writer state, no silent default that masks drift. Clean P1.

---

## 4. Concern Violations (P2)

| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|---------------|----------------------|----------|
| — | None | — | — | — |

- `report_generator.py` — single concern: "render a tracking-results PDF for the export set." Cohesive (see Finding M-1 on size).
- `project_routes.py` — the route's concern (project-scoped REST ops including `export_text`) is unchanged; the new route is a sibling, not a new concern.
- `modal_adapter.py` — only a delegation method added; concern unchanged.
- `useModalAdapter.js` / `ModalAdapter.jsx` — `generateTrackingReport` is a new export-action sibling to `exportToText`; no new concern. The component's existing "Apply/Export actions" concern absorbs the new button cleanly.

---

## 5. Patch / Workaround Findings (S5)

**TODO/FIXME/HACK count in scope:** 0 in `report_generator.py`; 0 new in any changed file.

| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| L-1 | Empty JS catch | `ModalAdapter.jsx:667` | Low | `handleCopyReportPath` swallows clipboard-write rejection with `catch {}`. **Justified:** inline comment explains the failure is benign (path is already shown in the success Alert); clipboard denial is a normal browser state, not a bug. Acceptable per the documented S5 UI carve-out. |
| L-2 | Defensive except | `report_generator.py:344` | Low (info) | `_render_grid_heatmap` wraps `get_grid_heatmap_data` in `except Exception as e` marked `# pragma: no cover - defensive`. **Not a swallow** — it renders "Heatmap unavailable: {e}" onto the PDF page (a visible, well-defined sentinel), so one mode's heatmap failing degrades gracefully instead of aborting the whole report. Arguably good practice. No re-raise needed because the failure is surfaced to the user on-page. |

No silent error-masking, no sleep-based synchronization, no legacy/migration shims, no "just in case" dead branches introduced. The new `generateTrackingReport` hook uses a proper `catch (err) { setError(...) }` (surfaces the backend error to the UI) — not a swallow.

---

## Level-1 Findings

| # | Principle | Severity | Confidence | File:Line | Description |
|---|-----------|----------|------------|-----------|-------------|
| **M-1** | C4 (YELLOW) | **Medium** | 90 | `report_generator.py` (whole, 590 LOC) | New file lands in the 500–1000 YELLOW band. **Discussed → keep as-is.** Single cohesive concern; a large share is docstrings (≈90 lines of header + per-method docs) and the irreducible JS-parity border-blend (`_build_heatmap_image` + `_paint_border_blend`, ≈75 lines). A premature split into `report_charts.py` would scatter the cohesive "render the report" concern across two files for no authority/concern benefit (S3: don't pre-abstract). **Recommendation:** leave unsplit now; revisit only if it grows past ~750 LOC or accretes a second chart family. Note it in the CODE_QUALITY YELLOW list at the next sync. |
| **L-3** | C4 regression | Low | 85 | `modal_adapter.py` (+26), `useModalAdapter.js` (+49), `ModalAdapter.jsx` (+94) | Three already-RED files grew. Per C4, adding to a RED file is a finding — but the rule's carve-out is "pure bug fix or a delegation that cannot live elsewhere." The `modal_adapter.py` add is a 3-line facade delegate (mandated by C4.1 — it *must* live in the facade to expose the new service to REST). The two frontend adds are the unavoidable hook + button surface for the feature (the hook owns REST calls; the button owns the Apply-panel UI). None could be relocated without violating the existing structure. **No split required for this change.** Flagged for visibility only. |
| **L-4** | A4 (default consistency) | Low | 80 | `report_generator.py:59`, `routes/project_routes.py:585`, `useModalAdapter.js` (caller), `ModalAdapter.jsx:649` | The smoothing default **1.5** is declared in 3+ places: `DEFAULT_SMOOTHING=1.5` (generator), `data.get('smoothing', 1.5)` (route), `smoothing: 1.5` (component `handleGenerateReport`), and documented as 1.5 in REST_API.md. They currently agree, but the value is duplicated rather than sourced once. Low risk because the component always passes an explicit `1.5` (so the route/generator defaults are belt-and-suspenders), and the doc matches. **Recommendation (optional):** treat the generator's `DEFAULT_SMOOTHING` as the single source and let the route omit its literal (pass `data.get('smoothing')` → `None` → generator default). Not blocking. |

---

## Subtle Bit — Heatmap-Blend Parity (the explicit review focus)

**Verdict: EXACT parity — verified numerically, confidence 95.**

`report_generator.py`'s `_palette_at` / `_build_heatmap_image` / `_paint_border_blend` were checked line-by-line against the authoritative on-screen renderer `GridHeatmapInset.jsx` (`paletteAt` / `computeBorderPaintOps` / `SmoothingOverlay`), then cross-validated by executing both on the same multi-cell grid (with null cells) at σ=1.5.

Element-by-element correspondence:

| Aspect | JS (`GridHeatmapInset.jsx`) | Python (`report_generator.py`) | Match |
|--------|------------------------------|--------------------------------|-------|
| Palette | 5 stops `1a237e→0277bd→26a69a→fdd835→ff5722`, RGB lerp | Same 5 stops `/255`, RGB lerp | ✓ |
| `paletteAt(t)` | `t≤0`→first, `t≥1`→last, `seg=t*(n-1)`, floor, frac blend | Identical (`int(np.floor)`) | ✓ |
| vMin/vMax | min/max of non-null; `vMax=vMin+1e-9` if equal | Identical | ✓ |
| Half-zone | `halfZoneX = σ*cellW/4` | `half = round(σ*ss/4)` (ss = px/cell) → same 0.375·cell fraction at σ=1.5 | ✓ |
| Null-cell rule | skip any border where either neighbor null; cells stay white | `if not (isfinite(vL) and isfinite(vR)): continue`; white bg | ✓ |
| Matrix mutation | never (overlay only) | never (raster copy; `ctx.tracked_chains` untouched) | ✓ |
| Border-h gradient | `x∈[border±halfZoneX]`, full row height, `t=dx/(w-1)` colL→colR | Identical (`width==1→t=0.5` guard present) | ✓ |
| Border-v gradient | `y∈[border±halfZoneY]`, full col width, colT→colB | Identical | ✓ |
| Containment clip | round-27 Change C: clip to 2-cell pair `[colEdges[c],colEdges[c+2]]` | `x0=max(c*ss,...)`, `x1=min((c+2)*ss,...)` | ✓ |
| Corner overlap | H-pass painted first, V-pass `fillRect` opaque on top (vertical-pass-wins) | H-pass loop first, V-pass assignment second (vertical-pass-wins) | ✓ |
| Grid orientation | `[nRows,nCols]=grid_shape`, `g[cell.row][cell.col]` | `n_rows,n_cols=grid_shape`, `grid[cell["row"],cell["col"]]` | ✓ |

**Numerical cross-check result** (Python `_build_heatmap_image` vs an independent faithful JS-algo re-implementation on a 3×4 grid with 3 null cells, σ=1.5, ss=16):
- `paletteAt` max channel diff over t ∈ [−0.2, 1.2] (71 samples incl. segment boundaries): **0.00e+00**
- raster max pixel diff: **0.00e+00**; mean pixel diff: **0.00e+00**
- null cells verified white in both.

**One documented (non-bug) nuance:** the live UI rasters in **fractional device pixels** (`cellW = plotPxW/nCols`) while the PDF uses an **integer `ss=16` px/cell** supersample. At the fixed σ=1.5 the stripe fraction is identical (0.375·cell both), so the result is pixel-exact. Only if the slider range were exercised at non-1.5 values *and* cellW were highly non-integer could `round(σ·ss/4)` differ from the JS device-pixel zone by ≤1 raster pixel — irrelevant to this report, which is hard-pinned to σ=1.5. This is a faithful replication, not an approximation.

**Shape-chart parity (bonus check): EXACT.** `_align_shape` + `_render_shape_chart` match `StabilizationDiagram.jsx` `alignShape` (ref = first detection with shape; sign-flip when dot<0) including the opacity ramp `0.3 + 0.7*((sc−first)/max(1, last−first))`.

---

## Endpoint Review (validation, error paths, path safety)

**Validation & consistency with `export_text`: PASS.** The route (`project_routes.py:559-610`) is a faithful mirror of `export_text_files_route`:
- `current_project` check → 400 with the same message shape if `name != adapter._current_project`.
- `selected_chains` → coerced to `[int(x) ...]`, 400 on `TypeError/ValueError`.
- **Adds** `smoothing` → `float(...)`, 400 on non-number — appropriate extra validation the sibling doesn't need.
- Empty export set: `_select_chains` returns `[]` → `generate_report` raises `ValueError("...selected no existing chains...")` → caught by `except (RuntimeError, ValueError)` → 400. (Note the route widens the sibling's `except RuntimeError` to `except (RuntimeError, ValueError)` precisely to cover this — correct.)
- No tracked chains / no mapping → `RuntimeError` → 400. Unexpected → `error_response(e)` (500). Error contract matches the documented table in REST_API.md.

**Path safety (`output_dir`): LOW risk, equivalent to the existing sibling — not a regression.** The endpoint passes `output_dir` straight to `os.makedirs(output_dir, exist_ok=True)` + `os.path.join(output_dir, f"{name}_tracking_report.pdf")` with no traversal/absolute-escape guard. **This is byte-for-byte the same treatment `export_to_text_files` already applies** (`apply_service.py:265-278`) — an absolute or `..`-laden `output_dir` would write outside the project dir in *both* endpoints. Since the modal adapter is a localhost-only single-user tool (port 5001, `threaded=False`) and the frontend never sends `output_dir` (it relies on the project-root default, Q1-b), the practical exposure is nil. **Recommendation (optional, applies to BOTH endpoints — log as a separate hardening item, not a blocker for this commit):** if path confinement is desired, add a shared helper that resolves `output_dir` against `ctx.project_dir` and rejects escapes (`os.path.commonpath`), and route both `export_text` and `tracking_report` through it. Flagging it on the new endpoint alone would be inconsistent.

**Q1-b project-dir save path: CORRECT.** `output_dir is None` → `ctx.project_dir` (with a `RuntimeError` if no project open and no override). PDF named `{current_project}_tracking_report.pdf`. Matches the documented Q1-b decision and the REST_API.md / GUIDE description. Verified by `test_grid_report_writes_pdf_to_project_root`.

---

## Frontend Review (MUI / dark-theme / gating / hook pattern)

**UI-standards compliance: PASS.** Uses MUI `Paper`/`Typography`/`Stack`/`Button`/`Alert` with `variant="outlined"`, `size="small"`, `sx` props — no raw HTML, no hardcoded hex, no inline `style`, dark-theme-consistent (inherits the surrounding Apply-panel theme). `data-testid`s present. Matches `.claude/CLAUDE.md` Frontend UI Standards.

**Button gating: PASS — matches `export_text`.** `disabled={reportBusy || !currentProject || trackingChains.length === 0 || (!exportTextAllChains && exportSelection.length === 0)}` — identical predicate to the export-text button (correctly requires a non-empty export set unless the "all chains" override is on). Busy label flips to "Generating...".

**Hook pattern: PASS — mirrors `exportToText`.** `generateTrackingReport` (useModalAdapter.js:1431-1465) follows the established shape: `if (!project.current) setError + return null`, `setLoading(true)`, `ensureModalServer()` guard, build body (omit `selected_chains` when not an array — matches the backend "null = all chains" contract), `axios.post` with `encodeURIComponent(project.current)`, `catch (err) { setError(err.response?.data?.error || err.message); return null }`, `finally setLoading(false)`. Added to the hook's return object. The `useCallback` dep array `[url, project.current, ensureModalServer]` is the same accepted pattern as the sibling `exportToText`.

**Error handling: PASS.** Backend errors surface to the user via `setError` (hook) and the success path renders a green Alert with the mode count, layout, smoothing, and the `pdf_path` in a `<code>` block. The "Copy PDF path" button degrades gracefully (L-1).

---

## Resource Handling

**matplotlib figure cleanup: PASS.** Every figure created (`_render_cover`, `_render_mode_page`) is closed with `plt.close(fig)` after `pdf.savefig(fig)`. The Agg backend is forced (`matplotlib.use("Agg")`) for headless safety in the single-threaded Flask worker. No figure leak across a large export set — each mode page is rendered and immediately closed inside the `with PdfPages(...)` block. Confirmed by the 18-mode/10-mode sample renders in the dev log without memory growth concerns.

**40-row cover-table cap: CORRECT.** `_render_cover` caps the on-page summary table at `max_rows=40` (`shown = rows[:max_rows]`) and prints "... and N more modes (see following pages)" when exceeded. The per-mode pages are still rendered in full regardless (loop over all `chains`), so no data is lost — only the cover summary is truncated for legibility. Sensible behavior.

**Big export-set performance: ACCEPTABLE.** O(n_modes) pages, each O(n_rows·n_cols·ss²) for the heatmap raster (ss=16) plus the per-pixel border-blend loops. For a 12×15 grid that is ~46k base pixels + bounded stripe loops per page — fast (the dev log's 777-chain project rendered an 8-mode export in ~305 KB without issue). The per-pixel Python loops in `_paint_border_blend` are the hottest spot; at realistic export-set sizes (tens of modes) this is sub-second and runs off the audio/synthesis path entirely (port 5001), so RT budgets are irrelevant. No concern.

---

## Recommendations (none blocking)

1. **(Medium, M-1)** Add `report_generator.py` (590 LOC) to the CODE_QUALITY.md YELLOW list at the next `sync`. Keep unsplit unless it grows past ~750 LOC.
2. **(Low, L-4)** Optionally collapse the smoothing-`1.5` default to a single source (generator `DEFAULT_SMOOTHING`); have the route pass `data.get('smoothing')` (→ `None` → default) instead of repeating the literal.
3. **(Low, path safety)** If `output_dir` confinement is wanted, add a *shared* resolve-and-confine helper used by **both** `tracking_report` and `export_text` — do not harden one endpoint in isolation.
4. **(Housekeeping)** Regenerate the CODE_QUALITY.md "Current Known God Objects" baseline (stale by ~1300 LOC across modal_adapter.py / useModalAdapter.js / ModalAdapter.jsx) at the next system review.

---

## Summary

**Pass — safe to commit as-is.** 5 findings: **0 Critical, 0 High, 1 Medium (M-1, accepted YELLOW), 4 Low.**

The headline concern — the Python replication of the JS pairwise-border heatmap blend — is **pixel-exact** (0.00 difference verified numerically across the palette and a null-cell-bearing grid at σ=1.5), with null cells white and the source matrix never mutated, faithfully matching `GridHeatmapInset.jsx`. The endpoint is a clean `export_text` mirror with correct validation and the documented Q1-b project-root save path; its only path-safety gap is identical to (and inherited from) the existing sibling endpoint, not a new risk. P1/P2 are clean (stateless read-only service, single concern, facade-policy-compliant 3-line delegate). Frontend matches MUI/dark-theme standards and the established hook/gating patterns. Tests pass (pytest 18/18 re-confirmed; Jest 4 new). Documentation was updated and (correctly) closed a stale doc-gap about backend gaussian smoothing.
