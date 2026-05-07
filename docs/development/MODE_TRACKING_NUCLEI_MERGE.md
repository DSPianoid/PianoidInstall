# Mode Tracking — Three-Stage Nuclei-Merge Algorithm

**Status:** Implemented in `feature/nuclei-merge-tracking` (dev-3st1, 2026-05-04).

This document describes the **third** mode-tracking algorithm in the modal-adapter
ESPRIT pipeline, sibling to the default `sliding_window` method (see
[`MODE_TRACKING_REDESIGN.md`](MODE_TRACKING_REDESIGN.md)) and the deprecated
`sequential` method.

The nuclei-merge method addresses a specific failure mode of the default
sliding-window method: chains visible in the stabilization diagram with **high
coverage**, **low scenario overlap**, and **very similar shapes** that are NOT
merged when they should be.

---

## 1. Problem Statement

Greedy peeling in the sliding-window pipeline confirms a frequency-shape
cluster as a chain and removes its detections from the candidate pool.  When
a single physical mode drifts substantially in frequency along the bridge
(e.g. from 1000 Hz at the bass end to 1100 Hz at the treble end — a 10 %
drift), the low-frequency half is confirmed in one window pass and the high-
frequency half is later confirmed as a SEPARATE chain in a different window
pass.

The legacy `_merge_split_chains` post-step CAN catch some such splits, but
its `freq_tol_pct * 2 = 6 %` chain-mean proximity gate rejects high-drift
splits like the 10 % case above.

**The user-spec'd nuclei-merge algorithm rebuilds the merge logic from
scratch around three stages with explicit, frontend-tunable thresholds.**

---

## 2. Three-Stage Pipeline

### Stage 1 — Nuclei Detection

A tighter sliding-window pass with a **HIGH** MAC threshold (default
`nm_nucleus_mac_threshold = 0.7`) over all detections.  Only the most
cohesive clusters survive.  These are the "nuclei" — guaranteed to be
single-physical-mode evidence with high confidence.

Detections not in any nucleus are reserved for Stage 3 stray-point
assignment.

Knobs:

| Field | Default | Role |
|---|---|---|
| `nm_nucleus_window_pct` | 0.03 | window half-width fraction (tighter than `sw_width_pct=0.05`) |
| `nm_nucleus_min_width` | 3.0 Hz | min window half-width |
| `nm_nucleus_mac_threshold` | 0.7 | HIGH MAC for cohesive nuclei (Stage-1 hard gate) |
| `nm_nucleus_min_detections` | 4 | stricter than `sw_min_detections=3` |
| `nm_nucleus_min_scenarios` | 4 | stricter than `sw_min_cluster_scenarios=3` |

### Stage 2 — Weighted Nuclei Merging

For every nucleus pair, compute a weighted score over (combined coverage,
scenario overlap, frequency proximity, MAC similarity).  **Damping is a
HARD GATE only** — per the spec refinement, per-detection ESPRIT damping
uncertainty is 10–30 %, so soft-cost weighting is unreliable.  Damping
remains a hard reject when difference > `nm_merge_max_damping_diff_pct`
(default 1.0 = 100 %).

#### Coverage × overlap matrix

| coverage | overlap | decision |
|---|---|---|
| HIGH | LOW  | **MERGE** (the user's stated rule) |
| LOW  | HIGH | **REJECT** (the user's stated rule) |
| HIGH | HIGH | **NEVER MERGE** — two well-populated competing nuclei = different modes; the well-populated overlap is itself evidence of distinctness |
| LOW  | LOW  | **MERGE only if frequency + MAC are tight** (mirrors the legacy `_merge_split_chains` gate) |

Definitions:

- **coverage**: combined coverage proxy = `coverage_a + coverage_b -
  overlap_coverage` ∈ [0, 1]
- **overlap**: `|S_A ∩ S_B| / min(|S_A|, |S_B|)` ∈ [0, 1] — normalised
  per the approved spec
- HIGH/LOW split: 0.5

#### Score formula

```
score = w_coverage * combined_cov
      - w_overlap * normalized_overlap   # subtractive penalty
      + w_freq * f_score
      + w_mac * mac_component
```

`mac_component = MAC` (∈ [0, 1]) when shapes are available; 0 otherwise
(behaviour mirrors `_merge_split_chains` shapeless-chain handling).

`f_score = 1 - (freq_diff_pct / nm_merge_max_freq_diff_pct)` ∈ [0, 1].

A pair merges when `score >= nm_merge_min_score`.  Default 0.3.

The **LOW + LOW fallback**: when coverage AND overlap are both low (the
weighted score under-weights freq+MAC because coverage drags it down),
re-evaluate using a freq+MAC-only criterion.  If `freq_score >= 0.8 AND
mac_val >= nm_merge_min_mac`, accept the merge.  This mirrors the spec's
"merge only if frequency + MAC are tight" rule.

#### Conflict resolution

After merge, conflicts on shared scenarios are resolved per-scenario by
assigning the detection to whichever nucleus has higher MAC against its
own reference shape.  This implements the analyst-recommended "option b"
from the planning round.

Knobs:

| Field | Default | Role |
|---|---|---|
| `nm_merge_max_freq_diff_pct` | 0.05 | only consider nuclei within this freq diff |
| `nm_merge_min_mac` | 0.5 | MAC HARD GATE (any merge requires MAC ≥ this) |
| `nm_merge_max_damping_diff_pct` | 1.5 | damping HARD GATE (>150% diff = reject — raised from 1.0 by dev-robust 2026-05-07; see § 6 "Robust per-fragment statistics") |
| `nm_merge_w_coverage` | 0.4 | weight on combined coverage component |
| `nm_merge_w_overlap` | 0.4 | weight on overlap penalty (subtractive) |
| `nm_merge_w_freq` | 0.1 | weight on freq proximity component |
| `nm_merge_w_mac` | 0.1 | weight on MAC similarity component |
| `nm_merge_min_score` | 0.3 | minimum total merge score to accept |

### Stage 3 — Stray-Point Assignment

Detections not in any Stage-1 nucleus get assigned to merged chains via
an INDEPENDENT weighted criterion (the weights are deliberately
different from Stage 2 — chain-level matching has different semantics
from nucleus-pair matching).

For each stray, the lowest-cost chain wins, BUT only if the cost is
below `nm_stray_max_assignment_cost`; otherwise the stray stays in the
unassigned pool (later surfaced via `TrackingResult.unassigned_detections`).

#### Cost formula

```
cost = w_freq * (|f_det - chain_mean| / chain_mean / freq_envelope_margin)
     + w_mac * (1 - MAC(chain_reference, det.mode_shape))
```

Hard rejects:

- Detection's frequency outside the chain's envelope (extended by
  `freq_envelope_margin`)
- Detection's scenario already in the chain (no displacement)
- MAC < `nm_stray_min_mac`

Knobs:

| Field | Default | Role |
|---|---|---|
| `nm_stray_min_mac` | 0.4 | MAC HARD GATE for stray assignment |
| `nm_stray_w_freq` | 0.5 | weight on freq distance from chain |
| `nm_stray_w_mac` | 0.5 | weight on (1 - MAC) from chain reference |
| `nm_stray_max_assignment_cost` | 0.5 | max cost — above this, stray stays unassigned |

---

## 3. Layout-Agnostic by Construction

The nuclei-merge algorithm is layout-agnostic — Stage 1 sorts detections
by frequency and never references `scenario_index` ordering, Stage 2's
coverage and overlap definitions work for any scenario set, and Stage 3
matches by frequency + MAC against chain references.

Therefore `tracking_method="nuclei_merge"` is **valid for both
`layout_type="line"` and `layout_type="grid"`**.  The layout guard in
`track_modes_along_bridge()` permits both `sliding_window` and
`nuclei_merge` on grid; only the deprecated `sequential` method is
rejected.

---

## 4. Public API

### `track_modes_along_bridge(per_scenario_detections, config=...)`

The standard dispatcher.  When `config.tracking_method == "nuclei_merge"`,
returns the final merged chains (Stages 1 + 2 + 3 applied).  Same return
type as the other two methods (`List[ModeChain]`).

### `track_modes_with_nuclei_snapshot(per_scenario_detections, config=...)`

The snapshot-aware entry point.  Returns the triple
`(final_chains, nuclei_stage_chains, leftover_strays)` so callers can
display the intermediate Stage-1 output for debugging or visualization.
Required for the frontend nuclei-view toggle on the stabilization
diagram.

Raises `ValueError` if `config.tracking_method != "nuclei_merge"`.

### `EspritRunner.run_tracking(...)` integration

The runner's existing `_run_tracking_sliding_window` shell is reused for
the nuclei_merge method (both are layout-agnostic and process all
scenarios at once).  When `tracking_method == "nuclei_merge"`, the shell
calls `track_modes_with_nuclei_snapshot` instead of
`track_modes_along_bridge` and includes `nuclei_stage_chains` in the
returned dict.  For other methods the field is `[]`.

### REST API

`POST /modal/run_tracking` body fields (extended):

```json
{
  "tracking_method": "nuclei_merge",
  "tracking_options": {
    "nm_nucleus_mac_threshold": 0.7,
    "nm_merge_min_mac": 0.5,
    "nm_merge_max_freq_diff_pct": 0.12
  }
}
```

`tracking_options` is a dict of `TrackingConfig` field overrides by name.
Unknown keys are ignored with a backend log warning.

`GET /modal/tracking_results` response includes `nuclei_stage_chains`
(empty list for non-nuclei_merge methods).

---

## 5. Sliding-Window Post-Merge Wire-Up (related fix)

Concurrent with the nuclei-merge algorithm, dev-3st1 also wired
`_merge_split_chains` into the default `_track_sliding_window` pipeline.
The merge step was previously only reachable via the sequential branch
and was unreachable for the default sliding_window path — a code-path
gap documented in `MODE_TRACKING_REDESIGN.md` § 4.4 but never wired in.

**Scope:** the wire-up only catches NARROW splits (within the
`freq_tol_pct * 2 = 6 %` chain-mean gate of `_merge_split_chains`).
The user's broader high-drift split complaint is addressed by the
nuclei-merge method, NOT by this wire-up.

**Configuration:** `sw_post_merge: bool = True` in `TrackingConfig`.
Set to `False` to opt out (regression-test-only scenario).

---

## 6. Robust per-fragment statistics (dev-robust, 2026-05-07)

**Status:** Default behaviour as of 2026-05-07. Master switch
`TrackingConfig.nm_robust_stats = True`; flip to `False` for legacy
arithmetic-mean / min-max aggregations (regression testing, emergency
rollback).

### Why

Naïve aggregations (`sum / N`, `min`, `max`) propagate a single ESPRIT
outlier detection — common with low-decimation Ultra-Low-band ESPRIT
which has noisy damping estimates — straight into the per-fragment
statistics that drive Stage-2 hard gates. Result: two fragments of the
SAME physical mode get rejected on damping difference because one
fragment captured a 5–15× damping outlier from a single bad ESPRIT
estimate, even though every other detection in both fragments agrees.

The fragmentation root cause is the Stage-1 window-grid alignment
(documented in
[`logs/dev-grid-stage1-fragmentation-analysis.md`](logs/dev-grid-stage1-fragmentation-analysis.md)).
The propagation root cause is the per-fragment statistic aggregation,
covered here. Together they produced the dev-grid skip=15 reproducible
production bug — two final chains for a single 60 Hz physical mode on
~33% of typical Ultra-Low band configs (see
[`logs/dev-grid-stage1-fragmentation-followup.md`](logs/dev-grid-stage1-fragmentation-followup.md)
§ A).

### Susceptible aggregations + estimator choices

| Statistic | Site | Estimator | Default param |
|---|---|---|---|
| `frequency_mean` | `ModeChain.finalize` | MAD-clipped mean | `c=3.0` (clean Gaussian-like) |
| `frequency_range` | `ModeChain.finalize` | percentile (lo, hi) | `10/90` (n>=5 only) |
| `damping_mean` | `ModeChain.finalize` | MAD-clipped mean | `c=2.5` (heavy outliers) |
| `_reference_shape` | `_detect_nuclei`, `_merge_nuclei_pairwise`, `_assign_strays` | iterative MAC-filter mean | `mac_threshold=0.5`, `max_iter=3` |

Per-statistic rationale (full discussion in
[`logs/dev-grid-robust-stats-analysis.md`](logs/dev-grid-robust-stats-analysis.md)
§ Step 2):

- **Frequency MAD c=3.0.** ESPRIT frequencies of the same mode across
  scenarios cluster tightly (0.05–0.3 Hz spread on a 60 Hz mode); true
  outliers are 1–2 Hz away and clearly separable. c=3 is the standard
  99.7%-coverage choice for approximately Gaussian data — for clean
  inputs the robust mean equals the arithmetic mean.
- **Damping MAD c=2.5.** Damping outliers are LARGE (3–10× median).
  c=2.5 cleanly separates them; c=3 may keep moderate outliers.
  MAD-clip + mean (not median outright) keeps the useful width
  information after outliers are removed.
- **Frequency range 10/90 percentile.** `min`/`max` ARE the outliers.
  Direct trimming via percentiles is the obvious answer. 10/90 (not
  5/95) gives ~3 samples on each tail for stable estimates at typical
  N=8–30 detections.
- **Reference shape iterative MAC filter.** Per-component trimming of
  complex vectors destroys vector geometry. Geometric median (Weiszfeld)
  is correct in principle but expensive. The iterative MAC filter
  re-uses the same MAC machinery already in the pipeline:
  `mean ← arithmetic mean → MAC each shape vs mean → drop MAC < 0.5 →
  recompute mean → repeat ≤ 3 times`. Always retains ≥ 3 shapes
  (degenerate otherwise — falls back to top-3 by MAC).

### Damping-gate band

Robust damping mean alone is insufficient on the dev-grid skip=15
case: it drops the bug-case ratio from 237.9% to 104.5%, still over
the 100% gate. The combined fix raises `nm_merge_max_damping_diff_pct`
from `1.0` (100%) to `1.5` (150%). Sweep on the prototype dataset:

| gate | skip=15 (bug) | skip=20 | skip=25 | skip=50 (different modes 59.10 + 60.72 Hz) |
|---:|---:|---:|---:|---:|
| 100% | **2 chains (bug)** | 1 | 1 | 2 (correctly distinct) |
| 120% | 1 (FIXED) | 1 | 1 | 2 (kept distinct) |
| **150%** | **1 (FIXED, recommended)** | **1** | **1** | **2 (kept distinct)** |
| 200% | 1 | 1 | 1 | 2 (kept distinct) |
| 300% | 1 | 1 | 1 | **1 (FALSE merge)** |

**Safe band: 120–200%.** 150% chosen for margin — it merges the
boundary-aligned fragments while keeping genuinely distinct modes
separate. False merges only appear at gates ≥ 300%.

### Configuration

| Field | Default | Role |
|---|---|---|
| `nm_robust_stats` | `True` | Master switch: True → robust path, False → legacy naïve path |
| `nm_robust_freq_mad_c` | `3.0` | MAD clip multiplier for `frequency_mean` |
| `nm_robust_damping_mad_c` | `2.5` | MAD clip multiplier for `damping_mean` |
| `nm_robust_range_lo_pct` | `10.0` | lower percentile for `frequency_range` |
| `nm_robust_range_hi_pct` | `90.0` | upper percentile for `frequency_range` |
| `nm_robust_shape_mac_threshold` | `0.5` | MAC inlier threshold for iterative shape mean |
| `nm_robust_shape_max_iter` | `3` | max iterations of MAC outlier filter |
| `nm_merge_max_damping_diff_pct` | `1.5` (was `1.0`) | Damping HARD GATE — see safe band table above |

### Production validation evidence (PlyWoodTake1_grid skip=15)

End-to-end run of `track_modes_nuclei_merge` on the live dataset at
the boundary-aligned `skip_start_ms=15.0` case:

| Path | 60 Hz chains | Detections | damping_mean |
|---|---|---|---|
| Legacy (`nm_robust_stats=False`, gate=100%) | **2** | 8 + 11 | 1.140% / 0.607% |
| Robust (default, gate=150%) | **1** | 19 | 0.456% |

The single merged chain holds the same 19 detections that the legacy
path split into two fragments. Validation matches dev-grid's prototype
result exactly (research notes Step 4a). Captured in
`tests/system/test_robust_stats_e2e.py` — auto-skipped when the
PlyWoodTake1_grid dataset is not on the test machine.

### Backwards compatibility

- Default flip from naïve → robust changes Stage-1 nucleus
  `frequency_mean` / `frequency_range` / `damping_mean` /
  `_reference_shape` for any chain whose detections include outliers.
  Clean datasets (no outliers) get bit-identical results because all
  inliers stay in the MAD-clipped set and the mean equals the
  arithmetic mean. The shape filter retains all shapes when MACs are
  uniformly above 0.5.
- The `nm_merge_max_damping_diff_pct` raise from 1.0 → 1.5 is paired
  with the robust mean. Used together they merge the dev-grid
  fragments without false-merging genuinely distinct modes (validated
  on PlyWoodTake1_grid; second-dataset validation is recommended
  before deploying to production datasets with densely-packed modes).
- Set `nm_robust_stats=False` AND `nm_merge_max_damping_diff_pct=1.0`
  to recover pre-2026-05-07 behaviour exactly. The legacy path is
  preserved as a regression-test safety net (covered by
  `tests/unit/test_mode_tracking_robust_integration.py
  ::test_robust_false_keeps_fragments_separate`).

### Research lineage

This production change was originally implemented and validated as a
research-only prototype by dev-grid. Production code was untouched
during the research phase. Files referenced (research-only, NOT shipped
to production):

- `tools/grid_search/robust_stats.py` — original prototype helpers
- `tools/grid_search/mode_tracking_robust.py` — full prototype
  replacement of `track_modes_nuclei_merge`
- `tools/grid_search/run_robust_eval.py`,
  `tools/grid_search/debug_robust_gate_sweep.py` — measurement
  harnesses

dev-robust translated the prototype into production code (new
`pianoid_middleware/modal_adapter/esprit/_robust_stats.py` module,
plumbed into `mode_tracking.py` + `mode_tracking_nuclei.py`) preserving
the prototype's public API surface (estimator names + parameters) so
the research artefacts remain valid validation references.

---

## 7. Test Coverage

`PianoidCore/tests/unit/test_mode_tracking.py`:

- `TestSlidingWindowPostMerge` — 3 cases: monkeypatched code-path verify
  the wire-up calls `_merge_split_chains`; narrow merge case where the
  helper actually engages; orthogonal-shapes no-merge case (existing MAC
  > 0.5 hardcoded gate honoured).

`PianoidCore/tests/unit/test_mode_tracking_nuclei.py`:

- `TestStage1Nuclei` — 3 cases: single obvious nucleus; sparse strays
  left unassigned; orthogonal-shape splitting.
- `TestStage2CoverageOverlapMatrix` — 5 cases covering all four
  matrix corners (HIGH+LOW, LOW+HIGH, HIGH+HIGH, LOW+LOW) plus the
  LOW+LOW loose-freq rejection.
- `TestStage2HardGates` — 3 cases: freq, MAC, damping hard rejects.
- `TestStage3StrayAssignment` — 4 cases: close-freq high-MAC assigned;
  far-freq high cost; orthogonal-shape rejected; no-displacement
  invariant.
- `TestUserFailureCase` — 2 cases: confirms the failure case (sliding
  window leaves split) and confirms nuclei_merge resolves it.
- `TestPublicNucleiSnapshotAPI` — 3 cases: triple return; wrong-method
  rejection; snapshot independence from final chains.
- `TestGridLayoutSupport` — 1 smoke test: nuclei_merge does not raise
  on `layout_type="grid"`.

All 22 nuclei tests + 53 existing `test_mode_tracking.py` tests
(including 3 wire-up tests) pass.

`PianoidCore/tests/unit/test_robust_stats.py` (dev-robust, 2026-05-07):

- `TestRobustMeanMad` — 11 cases covering empty / single-element /
  three-element fallbacks, all-equal degenerate, symmetric clean
  inputs, single-outlier clip, realistic damping outlier (replays the
  dev-grid scenario-11 5.19% outlier), two-sided outlier clip,
  numpy-array input, and the `c` clip multiplier effect.
- `TestRobustRange` — 7 cases covering empty / n<5 fallback (`min`,
  `max`), symmetric clean within bounds, single outlier excluded,
  monotonicity, n=5 boundary path, custom (25, 75) percentiles.
- `TestRobustShapeMean` — 9 cases covering empty / single / two-shape
  arithmetic-mean fallbacks, clean-similar all-inliers, single
  orthogonal outlier filtered, ≥3 shape retention guarantee, NaN /
  all-zero shape handled as MAC=0, max_iter respected, complex
  output dtype.

`PianoidCore/tests/unit/test_mode_tracking_robust_integration.py`
(dev-robust, 2026-05-07):

- `TestRobustStatsIntegration` — 4 cases: synthetic dataset reproducing
  the dev-grid skip=15 boundary-aligned + damping-outlier pattern
  (Stage-1 fragments BOTH paths into 2 nuclei). With
  `nm_robust_stats=True` Stage-2 merges the fragments into a single
  16-detection chain. With `nm_robust_stats=False` and
  `nm_merge_max_damping_diff_pct=1.0` Stage-2 keeps the fragments
  separate (legacy regression safety net). Clean-dataset sanity check
  produces identical results on both paths. Default-config sanity check
  pins `nm_robust_stats=True` and `nm_merge_max_damping_diff_pct=1.5`.

`PianoidCore/tests/system/test_robust_stats_e2e.py` (dev-robust,
2026-05-07):

- `TestRobustStatsE2E::test_skip15_60hz_mode_emits_single_chain_with_robust`
  — production end-to-end validation. Loads PlyWoodTake1_grid via the
  dev-grid harness `tools/grid_search/grid_search_ultra_low.py`, runs
  ESPRIT on the Ultra-Low band at `skip_start_ms=15.0`, runs production
  `track_modes_nuclei_merge` with default config. Asserts a single
  60 Hz chain emitted (pre-fix: 2 chains). Auto-skipped when the
  dataset or the harness module is missing.

`PianoidCore/tests/system/test_extended_bands_e2e.py` (dev-bands,
2026-05-07):

- `TestExtendedBandsE2E::test_ultra_low_new_defaults_60hz_single_chain`
  — production end-to-end validation. Loads PlyWoodTake1_grid via the
  dev-grid harness, runs ESPRIT on the Ultra-Low band with the new
  `EXTENDED_BANDS[0]` defaults (dec=8, ir=600 ms, skip=40 ms,
  start_fade=20 ms, end_fade=20 ms with universal "after" semantic),
  runs production `track_modes_nuclei_merge` with default config.
  Asserts the 60 Hz mode emits a single chain with ≥12 detections.
  Pins the dev-grid grid-search outcome into the production test
  suite. Auto-skipped when the dataset or harness is missing.

All new tests (32 in total) pass alongside the 75 pre-existing
mode-tracking tests.

---

## 8. Out of Scope (future work)

| Item | Status | Notes |
|---|---|---|
| Frontend MAC-threshold UI in `EspritConfig.jsx` | Phase B (this PR) | Surfaces all `nm_*` fields as user-tunable rows |
| Frontend nuclei-view toggle in `StabilizationDiagram.jsx` | Phase B (this PR) | Uses `/modal/tracking_results` `nuclei_stage_chains` field |
| Persist `nuclei_stage_chains` to disk in `tracking/chains.json` | Deferred | Would survive backend restart for nuclei view; currently nuclei live only in memory between `run_tracking` and `/tracking_results` GET |
| Live-data validation on Belarus + PlyWoodTake1 | Deferred | No dataset access in dev session; needs manual run + chain count comparison |
| Promote `nuclei_merge` to default `tracking_method` | **Done — dev-d773 (2026-05-05)** | See § 8 "Default Promotion" below |

---

## 9. Default Promotion (dev-d773, 2026-05-05)

**Status:** Default `TrackingConfig.tracking_method` changed from `"sliding_window"` to
`"nuclei_merge"`.

### Trigger

User-reported failure case in `tmp8c7q0lu0` (4×6 grid) — chain 7 + chain 8 near 50 Hz:

- Chain 7 (sliding_window output): 8 detections, freq 48.21–51.02 Hz (2.62 Hz drift),
  R²=0.10 (very poor freq smoothness), shape_consistency 0.626, 5.9% damping
  (suspiciously high).  Looks like a "junk drawer" cluster — the over-broad freq window
  admitted multiple distinct things whose averaged reference shape is "soup".
- Chain 8 (sliding_window output): 4 detections, freq 49.80–50.46 Hz (tight),
  shape_consistency 0.609, 0.13% damping (normal piano-mode territory).
- Whole-chain MAC(c7_ref, c8_ref) = 0.199 — fails the `_merge_split_chains` MAC > 0.5
  hardcoded gate, so sliding_window leaves them as TWO separate chains.
- Max single-pair MAC across the 32 c7×c8 detection pairs = 0.424 — meaning at least
  SOME of chain 7's detections ARE shape-similar to chain 8 individually.
- User's verbatim observation: "Chain 7 is not coherent, but there are at least one
  coherent cluster inside c7 that is very close to c8.  Fix the algorithm."

### Why the default switch addresses it

- **Stage 1 high MAC threshold (0.7)** refuses to admit chain 7's mixed shapes as a
  single cohesive nucleus.  Only genuinely cohesive detection subsets survive Stage 1 —
  which means chain 7's "junk drawer" either splits into multiple smaller nuclei or
  fails to form any nucleus at all (its detections become Stage-3 strays).
- **Stage 3 stray-point assignment** routes each leftover detection to whichever
  surviving chain has the lowest cost match (subject to `nm_stray_min_mac=0.4` hard
  gate).  Detections shape-similar to chain 8 should attach to chain 8's chain rather
  than getting glued into the over-broad c7.

### Caveat on validation

The dev-d773 session could NOT construct a synthetic regression test that demonstrates
nuclei_merge resolves the chain-7+8 case differently from sliding_window.  Three
attempts are documented in
[`logs/dev-d773-2026-05-05-002518.md`](logs/dev-d773-2026-05-05-002518.md) "Honest
assessment of regression test scope".  The fundamental reason: in any synthetic case
where junk shapes mutually agree (so they cluster together in sliding_window), the
junk-averaged MAC against the sub-cluster naturally HAS to be higher than the
sub-cluster's MAC against ChainA — that's the math that produces the over-broad cluster
in the first place.  The real Belarus data must have an asymmetry in shape MACs that we
cannot reproduce without the live dataset.

**Validation that DID run:**

- All 73 mode-tracking tests pass (72 existing + 1 new default-assertion test).
- The known nuclei_merge win case (`TestUserFailureCase` — high-coverage low-overlap
  large-freq-drift) still validates.
- One existing test (`test_modal_adapter_grid_layout::test_default_tracking_method_unchanged`)
  was updated to assert the new default with explanatory comment.
- No regression elsewhere in the suite (485/485 unit tests passing on the changed
  modules; 2 pre-existing unrelated failures unchanged).

**Validation NOT performed (future follow-up):**

- Manual re-run of tracking on `tmp8c7q0lu0` post-merge to confirm whether nuclei_merge
  actually produces a better chain decomposition.  If it doesn't, the user may need
  the deferred Option B (sub-cluster-aware merge step) as a follow-up — see
  `WORK_IN_PROGRESS.md` dev-d773 deferred follow-ups.

### Backward-compatibility impact

- Existing callers that pass `TrackingConfig()` (no explicit `tracking_method`) now get
  nuclei_merge instead of sliding_window.  Chain IDs and counts will likely differ on
  the same input data — by design.
- Existing callers that pass `TrackingConfig(tracking_method="sliding_window")`
  explicitly are unaffected.
- Saved tracking results on disk (`tracking/chains.json` per project) are NOT
  invalidated — they remain readable.  But re-running tracking on the same project
  will produce different chain_ids / counts because of the algorithm switch.
- Frontend chain selector (dev-c807, in flight) needs no code change — it operates on
  whatever chains the backend serves.  User selections persist within a single tracking
  run; they are invalidated by re-running tracking (this is true regardless of the
  algorithm switch — re-running tracking always invalidates chain_ids).
