# Outlier-robust per-fragment statistics — analysis & prototype

Generalisation of the damping-only outlier issue to ALL Stage-2/Stage-3 gates.
Research-only; no production code changed.

## Executive summary

- **Audit found 4 susceptible per-fragment statistics** (`frequency_mean`,
  `frequency_range`, `damping_mean`, `_reference_shape`) that feed Stage-2/3
  hard gates and are computed as naive mean / min-max with no outlier
  protection.
- **Per-statistic estimator chosen** (justified per parameter): MAD-clipped
  mean for damping (c=2.5) and frequency (c=3.0), 10/90 percentile for
  frequency_range, iterative MAC-based outlier filter for the complex
  reference shape (mean → drop low-MAC shapes → recompute → iterate).
- **Prototype measured improvement:**
  - S1 noise floor Q_std drops from **0.2120 → 0.1840 (-13.2%)** with robust
    stats alone.
  - At skip=15, the bug-case damping ratio drops from 237.9% to 104.5% — JUST
    over the 100% gate. Pairing robust stats with a relaxed damping gate
    (100%→150%) **merges the fragments correctly (n=19)**.
  - skip=50 (genuinely two distinct modes at 59.10 + 60.72 Hz) **stays
    correctly separated** under both robust+150% and robust+200% — the gate
    relaxation does NOT cause false merges of distinct modes.
- **Recommended production change** (combined): adopt outlier-robust
  statistics + relax `nm_merge_max_damping_diff_pct` from 1.0 (100%) to 1.5
  (150%). Validate on a second dataset before merging.

## Step 1 — Audit table

| Statistic | Computed in | Used by | Susceptible? | Failure mode |
|---|---|---|---|---|
| `frequency_mean` | `ModeChain.finalize:330` (arith mean of `d.frequency`) | `_freq_proximity_score` (Stage-2 freq gate + freq-score component) | YES | One bad ESPRIT freq estimate (1-2 Hz off) shifts mean by 0.1-0.5 Hz; on a 60 Hz cluster that's 0.2-0.8% — drifts toward the freq gate. |
| `frequency_range` | `finalize:331` (`min`, `max`) | `_stray_cost` envelope gate (Stage 3) | YES (extreme) | min/max ARE outliers — a single 65 Hz outlier on a 60 Hz cluster widens range to (59, 65), opening the Stage-3 envelope wider and causing strays from a different physical mode to be mis-assigned. |
| `frequency_drift` | `finalize:337` (last-first scenario freq) | reporting only | NO | informational. |
| `damping_mean` | `finalize:342` (arith mean) | Stage-2 damping HARD GATE | **YES — confirmed bug** | Single 5.19% damping ESPRIT outlier in scenario 11 dragged mean to 1.14% vs other fragment 0.34%. 237.9% diff > 100% gate → reject_damping. |
| `_reference_shape` | nuclei: `_detect_nuclei:201` (mean of rotated shapes); tracker: EMA `add_detection:254`; merged: weighted-mean `_merge_nuclei_pairwise:454` | Stage-2 MAC HARD GATE, Stage-3 MAC HARD GATE, conflict resolution | YES | A single bad ESPRIT shape (rotation/sign-flip not caught by `_rotate_shape`, or wrong-mode pickup) shifts the mean direction in C^M space; subsequent MAC against the polluted reference may drop below 0.5 even for true same-mode shapes. |
| `coverage` | `finalize:333` (count/total) | Stage-2 coverage matrix, classification | NO | count, not aggregate. |
| `_freq_proximity_score`'s `f_ref` | `_freq_proximity_score:253` `min(a, b)` | Stage-2 freq gate | derived from `frequency_mean` | already covered by fixing `frequency_mean`. |
| `_damping_diff_pct`'s `ref` | `_damping_diff_pct:274` `min(a, b)` | Stage-2 damping gate | derived | already covered. |
| `damping_std` | `_compute_chain_quality:404` | reporting only (CV → `damping_stability`) | YES but no gate | informational; not actioned. |

**Susceptible-and-gating list: `frequency_mean`, `frequency_range`,
`damping_mean`, `_reference_shape`.**

## Step 2 — Per-statistic estimator choice

Each statistic gets ONE specific method based on its distribution shape and
how the gate downstream consumes it.

### `damping_mean` → MAD-clipped mean, c = 2.5

- Distribution: heavy-tailed asymmetric. Damping per scenario for a single
  physical mode clusters tightly (e.g. 0.3-1.5 %); ESPRIT noise occasionally
  produces outliers at 3-10× the median.
- Why MAD over IQR: with N≈8 dets per fragment, IQR's quartile estimates are
  noisy; MAD's median-of-absolute-deviations is more robust on small samples.
- Why c = 2.5 (not 3): damping outliers are LARGE (3-10× median); c = 2.5
  cleanly separates them. c = 3 may keep moderate outliers.
- Why MAD-clip + mean (not median outright): once outliers are removed, the
  remaining distribution has useful width information that the median
  discards. The cleaned arithmetic mean is the right central estimate for
  comparing fragments.

### `frequency_mean` → MAD-clipped mean, c = 3.0

- Distribution: ESPRIT frequencies of the SAME mode across scenarios are
  TIGHT (0.05-0.3 Hz spread on a 60 Hz mode) — well-modelled as Gaussian.
  True outliers (ESPRIT picked a different mode, or freq estimate diverged)
  are 1-2 Hz away — clearly separable.
- Why c = 3.0 not 2.5: frequency distribution has natural width from physical
  drift across scenarios; c = 2.5 may over-clip legitimate spread. c = 3 is
  the standard 99.7%-coverage choice for approximately Gaussian data.

### `frequency_range` → 10th/90th percentile

- min/max ARE the outliers — directly using percentiles trims them.
- Why 10/90 over 5/95: with N=8-30 dets, 5%/95% is too close to absolute
  extremes (~1 sample); 10/90 gives ~3 samples on each tail and a stable
  estimate.

### `_reference_shape` → iterative MAC-based outlier filter

- Distribution geometry: complex vectors in C^M (M = #channels). Per-component
  trimming destroys vector geometry — wrong approach.
- Geometric median: correct in principle but Weiszfeld iteration is expensive
  for this inner loop.
- **Practical choice**: iterative MAC-outlier filter:
  1. Initialise mean = arithmetic mean of all rotated shapes.
  2. Compute MAC of each shape vs current mean.
  3. Drop shapes with MAC < 0.5 (the same threshold as Stage-2 hard gate).
  4. Recompute mean on inliers.
  5. Repeat up to max_iter=3 times or until set converges.
- Always keep ≥ 3 shapes (degenerate otherwise).

Note: tracking-time EMA shape update (`add_detection:254`) was NOT touched —
it's per-detection incremental and the chain doesn't see all shapes at once.
The robustness is applied at Stage-1 nucleus formation and at every
post-merge / post-stray-assignment recompute.

## Step 3 — Code-edit specification (production)

New helpers in `mode_tracking.py` (or a new `_robust_stats.py` next to it):

```python
def _robust_mean_mad(values, c=2.5) -> float
def _robust_range(values, lo_pct=10.0, hi_pct=90.0) -> Tuple[float, float]
def _robust_shape_mean(shapes, mac_threshold=0.5, max_iter=3
                       ) -> Tuple[np.ndarray, List[int]]
```

New `TrackingConfig` fields:

```python
nm_robust_stats: bool = True            # master switch (default ON)
nm_robust_freq_mad_c: float = 3.0
nm_robust_damping_mad_c: float = 2.5
nm_robust_range_lo_pct: float = 10.0
nm_robust_range_hi_pct: float = 90.0
nm_robust_shape_mac_threshold: float = 0.5
nm_robust_shape_max_iter: int = 3
nm_merge_max_damping_diff_pct: float = 1.5    # CHANGED 1.0 -> 1.5
```

Edit sites:

1. **`ModeChain.finalize` (`mode_tracking.py:325-355`)** — replace bare
   arithmetic mean and min/max with robust helpers. Two sub-options:
   (a) pass `config` to `finalize` (signature change touching ~10 call sites)
   (b) add a class-level attribute `chain._robust_stats: bool` set when the
   chain is created.

   Prototype uses approach (a) for clarity; production roll-out can prefer
   (b) for minimal call-site churn — the boolean is set once at chain
   construction and `finalize` reads it via `self._robust_stats`.

2. **`_detect_nuclei` (`mode_tracking_nuclei.py:200-202`)** — replace
   `nucleus._reference_shape = sum(rotated)/len(rotated)` with
   `_robust_shape_mean(rotated, mac_threshold=cfg.nm_robust_shape_mac_threshold)`.

3. **`_merge_nuclei_pairwise` (`mode_tracking_nuclei.py:447-456`)** — instead
   of weighted average of two `_reference_shape` vectors, recompute the
   reference shape from the union of detections in the merged target,
   passing through `_robust_shape_mean`.

4. **`_assign_strays` (`mode_tracking_nuclei.py:550-551`)** — after stray
   ingestion, recompute the reference shape (some strays may shift the mean)
   AND re-finalize using robust helpers.

5. **Default `nm_merge_max_damping_diff_pct`** — change from 1.0 to 1.5. The
   robust damping mean already drops the bug-case ratio from 237.9% to
   104.5% (just over the 100% gate); the relaxation accommodates the
   small remaining bias from sample-size effects.

## Step 4 — Prototype + measurement

Prototype files (research-only):

| File | Role |
|---|---|
| `tools/grid_search/robust_stats.py` | Three robust helpers |
| `tools/grid_search/mode_tracking_robust.py` | Full robust replacement of `track_modes_nuclei_merge` (Stage-1 nucleus, Stage-2 merge, Stage-3 strays). Production functions untouched. |
| `tools/grid_search/run_robust_eval.py` | Verification + S1 noise floor + S2 skip sweep |
| `tools/grid_search/debug_robust_merge.py` | Trace why skip=15/50 still fragmented under robust |
| `tools/grid_search/debug_robust_gate_sweep.py` | Damping-gate sweep (100/120/150/200/300 %) on robust algo |
| `tools/grid_search/run_robust_eval_v2.py` | Robust + gate=150% noise-floor confirmation |

### Measured impact

#### 4a. Robust stats with default gate (100 %)

Stage-2 verification (boundary skips):

| skip | production final 60Hz | robust final 60Hz | bug fixed? |
|--:|---|---|---|
| 15 | 2 chains (n=8 + n=11) | 2 chains (n=10 + n=9) | partial — diff dropped from 237→105% but still > gate |
| 20 | 1 chain (n=21) | 1 chain (n=21) | (no bug) |
| 25 | 1 chain (n=20) | 1 chain (n=20) | (no bug) |
| 50 | 2 chains (n=8 + n=11) | 2 chains (n=8 + n=11) | NOT fixed — but these are different modes |

S1 noise floor (10 runs, leave-3-out subsetting):

| | Q_std (lower=better) | Q_median |
|---|---:|---:|
| Production | 0.2120 | 1.8067 |
| Robust | **0.1840** | 1.8805 |
| **Δ** | **−13.2 %** | +4.1 % |

#### 4b. Damping gate sweep on robust algo

Final 60Hz nuclei count, format `n_chains/max_dets`:

| gate | skip=15 | skip=20 | skip=25 | skip=50 |
|--:|--:|--:|--:|--:|
| 100% | **2/10** (frag) | 1/21 | 1/20 | 2/11 |
| **120%** | **1/19** (FIXED) | 1/21 | 1/20 | 2/11 (kept distinct) |
| 150% | 1/19 | 1/21 | 1/20 | 2/11 |
| 200% | 1/19 | 1/21 | 1/20 | 2/11 |
| 300% | 1/19 | 1/21 | 1/20 | **1/19 (false merge)** |

Reading: at gate ≥ 120%, the skip=15 fragments merge into a single n=19
chain. The skip=50 separation (correctly preserved at 100%-200%) collapses
incorrectly at 300% — i.e. 300% is too lenient and merges genuinely
different physical modes (59.10 vs 60.72 Hz). The safe band is
**[120%, 200%]**; **150% is recommended** as it gives margin.

#### 4c. Robust + gate=150% noise floor

Same dataset, 10 runs, leave-3-out:

| | Q_stage1_std | Q_stage1_median |
|---|---:|---:|
| Production (gate 100%) | 0.2120 | 1.8067 |
| Robust (gate 100%) | 0.1840 | 1.8805 |
| **Robust + gate 150%** | **0.1840** | **1.8805** |

The relaxed gate operates downstream of Stage-1 nuclei; the Stage-1
quality metric is unchanged. The IMPORTANT change is in Part 1
verification: skip=15 now produces a single n=19 chain (was n=10/9
fragmented).

## Step 5 — Risk analysis

### False-positive merges across genuinely different modes

The damping-gate-sweep table directly answers this. At every gate ≤ 200%,
skip=50 stays correctly split (the 59.10 Hz mode is a different physical
mode from the 60.72 Hz one). Only at 300% does false merging start. So:

- 120-150% — no false merges observed on this dataset; no over-merging at
  any tested skip.
- 200% — no false merges either.
- 300% — false merge of the 59.10 + 60.72 Hz modes.

**Recommended: 150%** (mid-band of the safe range).

### Frequency-robustness side effects

Robust frequency mean (c=3.0) is a CONSERVATIVE robustification — for
Gaussian data with no outliers, MAD-clipping at c=3 keeps ~99.7% of
samples. So frequency_mean essentially equals the arithmetic mean for
clean clusters, only diverging when a clear outlier exists. Verified
in the verification table — the small freq_mean shifts (60.35 → 60.44,
60.72 → 60.67, 60.57 → 60.63 etc.) are within 0.1 Hz, no semantic
disruption.

### Range-robustness side effect on Stage-3

Trimmed range (10/90 percentile) is TIGHTER than min/max → the Stage-3
envelope `frequency_range × (1 ± freq_envelope_margin)` becomes narrower
when the chain has outlier frequency dets. This could cause some strays
that previously got assigned to be left unassigned. Mitigation: the
Stage-3 cost is dominated by `freq_envelope_margin` (default ~5%); with a
2-3% trimmed range, this only matters when the original range was
inflated by a single outlier (which is exactly the case we want to fix —
prevents wrong-mode strays from being absorbed). On the test dataset
the post-merge final-chain count was unchanged at all skip values.

### Shape-robustness side effect

Iterative MAC-filter shape mean is more concentrated than the naive mean
when shapes are noisy. Verified empirically: at skip=50, the lower
fragment's intra_mac jumped from 0.672 (naive) → 0.875 (robust) — a
solid quality improvement. No degradation observed at any skip.

## Step 6 — Production-adoption recommendation

**Validate on a second dataset, then adopt as combined change.**

The combined change (robust stats + damping gate 150%) achieves three
things measurably:

1. Fixes skip=15's Stage-1+Stage-2 fragmentation bug (the single
   reproducible production bug from the prior dev-grid investigation).
2. Reduces S1 noise-floor Q_std by 13.2% — a real, measurable improvement
   in run-to-run stability.
3. Does NOT cause false merges of genuinely different modes at the
   recommended gate value.

**Do not adopt without second-dataset validation** because:

- The dataset (PlyWoodTake1_grid, 30 scenarios, 60-Hz dominant mode) is a
  single point. Other datasets may have densely-packed modes where the
  150% gate could cause false merges.
- The frequency MAD-clip at c=3 is conservative but the damping MAD-clip
  at c=2.5 is more aggressive — it could clip legitimate damping spread
  in datasets where damping is genuinely highly variable across
  scenarios (e.g. a structure with strong nonlinearity).
- The shape iterative-MAC filter has not been tested with shapeless
  edge cases (production has fallback paths for `mode_shape is None`;
  prototype reproduces them but a second dataset will exercise more
  edge cases).

### Validation plan for second dataset

1. Run `run_robust_eval.py` (existing) on the second dataset.
2. Run `debug_robust_gate_sweep.py` to confirm the 120-200% gate band
   produces no false merges.
3. Compare final chain counts (production vs robust) at default
   skip values — should be ≤ +1 chain difference at most for genuinely
   close mode pairs.
4. Spot-check the chain MAC quality scores — should be ≥ production.

If validation passes, the production change is:

```diff
# pianoid_middleware/modal_adapter/esprit/mode_tracking.py
@dataclass
class TrackingConfig:
    ...
-   nm_merge_max_damping_diff_pct: float = 1.0
+   nm_merge_max_damping_diff_pct: float = 1.5
+   # Outlier-robust statistics
+   nm_robust_stats: bool = True
+   nm_robust_freq_mad_c: float = 3.0
+   nm_robust_damping_mad_c: float = 2.5
+   nm_robust_range_lo_pct: float = 10.0
+   nm_robust_range_hi_pct: float = 90.0
+   nm_robust_shape_mac_threshold: float = 0.5
+   nm_robust_shape_max_iter: int = 3
```

Plus the new helpers in a new `_robust_stats.py` module and the edit
sites listed in Step 3.

## Files

Research-only; production code unchanged:

- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\robust_stats.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\mode_tracking_robust.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\run_robust_eval.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\run_robust_eval_v2.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\debug_robust_merge.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\debug_robust_gate_sweep.py`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\results\robust_eval.log`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\results\robust_eval.json`
- `D:\repos\PianoidInstall\PianoidCore\tools\grid_search\results\debug_robust_merge.log`
