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
| `nm_merge_max_damping_diff_pct` | 1.0 | damping HARD GATE (>100% diff = reject) |
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

## 6. Test Coverage

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

All 21 nuclei tests + 51 existing `test_mode_tracking.py` tests
(including 3 new wire-up tests) pass.

---

## 7. Out of Scope (future work)

| Item | Status | Notes |
|---|---|---|
| Frontend MAC-threshold UI in `EspritConfig.jsx` | Phase B (this PR) | Surfaces all `nm_*` fields as user-tunable rows |
| Frontend nuclei-view toggle in `StabilizationDiagram.jsx` | Phase B (this PR) | Uses `/modal/tracking_results` `nuclei_stage_chains` field |
| Persist `nuclei_stage_chains` to disk in `tracking/chains.json` | Deferred | Would survive backend restart for nuclei view; currently nuclei live only in memory between `run_tracking` and `/tracking_results` GET |
| Live-data validation on Belarus + PlyWoodTake1 | Deferred | No dataset access in dev session; needs manual run + chain count comparison |
| Promote `nuclei_merge` to default `tracking_method` | Deferred | Stays opt-in until validated against multiple datasets |
