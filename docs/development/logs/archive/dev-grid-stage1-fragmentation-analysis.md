# Stage-1 Fragmentation — Root Cause Analysis (2026-05-07)

**Investigator:** dev-grid
**Sources:** `mode_tracking_nuclei.py:_detect_nuclei` (lines 72-216), traced
through PlyWoodTake1_grid 60 Hz mode at skip=15 (fragments) vs skip=20 (consolidates).

---

## Executive summary

The Stage-1 nucleus detector is fragile because of its **discrete, non-overlapping window-grid anchored at the noise-driven minimum frequency**. When a physical mode's detection cloud straddles a grid boundary, greedy peeling splits the mode into two nuclei that can never be re-merged in Stage 1.

This is **algorithmic fragility**, not a bug and not just noise sensitivity. The algorithm is doing what it was written to do; what it was written to do has a known failure mode for boundary-straddling clusters.

The fix has multiple options ranked at the bottom; the simplest (overlap the windows by 2x) likely closes most cases.

---

## A. Algorithm structure (read from `mode_tracking_nuclei.py:72-216`)

`_detect_nuclei(all_dets, total_scenarios, config)`:

1. Sort all detections by frequency. Set `f_center = f_min_global` (the lowest detection frequency in the entire pool, line 106).
2. Loop:
   - `half_w = max(nm_nucleus_min_width=3.0, nm_nucleus_window_pct=0.03 × f_center)` (line 109-110).
     **At ultra-low band f_center ∈ [30, 100], half_w is always pinned at the floor 3.0 Hz.**
   - Window: `[f_center - half_w, f_center + half_w]`, i.e. 6 Hz wide.
   - Find unassigned detections in window (line 116) — **greedy peeling: previously-clustered detections are excluded**.
   - If < 4 unassigned detections in window: skip; advance `f_center += half_w` (line 119, 210).
   - Otherwise:
     - Build pairwise distance matrix using `dist = 0.4 * (Δf / 6Hz) + 0.6 * (1 - MAC)` (lines 142-149).
     - scipy `linkage(dist, method='average')` (line 151).
     - Cut at distance `0.4 * 0.3 + 0.6 * (1 - 0.7) = 0.30` (line 164, default MAC threshold 0.7).
     - For each resulting cluster:
       - If ≥ 4 detections AND ≥ 4 distinct scenarios → emit a nucleus, mark its detections `assigned=True` (lines 174-208).
   - Advance `f_center += half_w` (line 210). **`half_w` step = no overlap** between consecutive windows.

3. Sort nuclei by mean frequency, return.

The relevant `TrackingConfig` defaults (mode_tracking.py:154-158):
```python
nm_nucleus_window_pct: float = 0.03
nm_nucleus_min_width: float = 3.0
nm_nucleus_mac_threshold: float = 0.7
nm_nucleus_min_detections: int = 4
nm_nucleus_min_scenarios: int = 4
```

---

## B. The 60 Hz failure mode — traced

### Setup

Both configs use `(ir=600, fin=20, fout=0, dec=4)` on full 30 PlyWoodTake1 scenarios. They differ only in `skip_start_ms`: 15 vs 20. The dominant 60 Hz mode is detected in 18-19 of 30 scenarios with very tight frequency clustering at ~60.5 Hz and high mode-shape MAC.

### Raw detection clouds (58-62 Hz band)

| skip | n_dets in 58-62 | min freq | max freq |
|--:|--:|--:|--:|
| 15 | 18 | 58.20 | 61.84 |
| 20 | 19 | 58.19 | 61.88 |

**Essentially identical** — same physics, marginal differences in individual freq estimates.

### What `_detect_nuclei` does to each

**`f_min_global` differs** by 0.38 Hz across the two configs because of slightly different lowest-frequency detections (skip=15 → 30.52 Hz; skip=20 → 30.14 Hz). This shifts the entire window grid.

**At skip=15** (window grid = 30.52 + k × 3 = 30.52, 33.52, 36.52, ..., 57.52, 60.52, 63.52, ...):

| step | f_center | window | available dets | result |
|---:|---:|---|---:|---|
| 9 | 54.52 | [51.52, 57.52] | 2 | skip |
| **10** | **57.52** | **[54.52, 60.52]** | 10 (catches 8 of 18 of the 60 Hz cloud, f≤60.51) | **emits 8-det nucleus at f=60.35** |
| **11** | **60.52** | **[57.52, 63.52]** | 12 (the OTHER 8 of the 60 Hz cloud, f≥60.53, plus 4 strays) | **emits 8-det nucleus at f=60.72** |

**The 60 Hz cloud's median frequency is 60.52 Hz — exactly at the window boundary.** Half the dets (f ∈ [59.76, 60.51]) are in window 10; other half (f ∈ [60.53, 61.04]) are in window 11. Greedy peeling cements the split.

**At skip=20** (window grid = 30.14 + k × 3 = 30.14, 33.14, 36.14, ..., 57.14, 60.14, 63.14, ...):

| step | f_center | window | available dets | result |
|---:|---:|---|---:|---|
| 9 | 54.14 | [51.14, 57.14] | 2 | skip |
| 10 | 57.14 | [54.14, 60.14] | 3 | **skip (< 4 dets)** |
| **11** | **60.14** | **[57.14, 63.14]** | 21 (ALL 18 of the 60 Hz cloud + 3 strays) | **emits ONE 18-det nucleus at f=60.54** |

The 60 Hz cloud's median (60.65 Hz) sits ~0.51 Hz from the nearest window boundary, near the centre of window 11 — all 18 dets fall cleanly into that single window. **Single 18-det nucleus** with cov=0.600.

### Cause confirmed by quantitative measurement

Across the 9 skip values tested in S2:

| skip | f_min | 60Hz_median | dist_to_grid_boundary | #nuclei in 60Hz | largest n_dets |
|---:|---:|---:|---:|---:|---:|
| 0 | 30.42 | 60.48 | **0.06 Hz** | **2** | 10 |
| 5 | 30.20 | 60.44 | 0.24 Hz | 1 | 15 |
| 10 | 30.15 | 60.48 | 0.34 Hz | 1 | 17 |
| **15** | 30.52 | 60.52 | **0.00 Hz** | **2** | **8** |
| 20 | 30.14 | 60.65 | 0.51 Hz | 1 | 18 |
| 25 | 30.07 | 60.58 | 0.51 Hz | 1 | 20 |
| 30 | 31.03 | 60.61 | 0.41 Hz | 1 | 16 |
| 40 | 30.89 | 60.53 | 0.36 Hz | 1 | 16 |
| **50** | 30.44 | 60.50 | **0.06 Hz** | **2** | **11** |

**The fragmentation is a deterministic function of how close the 60 Hz mode's detected center is to a window boundary `f_min + k × 3 Hz`.**

`dist_to_grid_boundary < 0.1 Hz` (i.e. < 1.7 % of half_w) → fragmentation.
`dist_to_grid_boundary > 0.2 Hz` → consolidation.

This perfectly explains the S2 sigma analysis: the 3 "real" Q dips (skip=0, 15, 50) are exactly the configs where the 60 Hz cloud aligns with a grid boundary.

### Synthetic confirmation

Shifting all detection frequencies by ±0.5 Hz (which also shifts `f_min`) keeps fragmentation, because the `(60Hz_median - f_min) % 3.0` invariant is preserved. The fragmentation is an algorithmic artefact, not a property of the data.

---

## C. Hypothesis ranking

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **A. Algorithmic fragility (window-grid alignment)** | **DOMINANT (essentially the entire effect)** | 9-of-9 S2 configs explain Q variation by `dist_to_grid_boundary`. The 60 Hz cloud straddling a window boundary at 1.7 % of half_w is enough to split 18 dets into 8+8. Synthetic shift confirms. |
| B. MAC threshold too close to noise floor | Minor / negligible | Threshold sweep at the failure window showed clustering is very stable across MAC ∈ [0.50, 0.65]: always one 9-det cluster. Only at MAC ≥ 0.68 does the SAME-WINDOW cluster start to fragment further. The dominant fragmentation happens BEFORE clustering, in window selection. |
| C. ≥4-scenarios hard gate at boundary | Not relevant for 60 Hz | The 60 Hz mode has 18-20 detections so it never bumps against the 4-scenarios floor. Hard gate matters for weaker modes (e.g. the 90 Hz mode with only 4-5 dets). |
| D. Damping spread filter | Not applicable | Stage-1 has no damping filter; damping is a Stage-2 hard gate only. |
| **Latent bugs?** | None found | The code does what its docstring says. The fragility is by construction, not by mistake. |

---

## D. Why this matters at the metric level

The Q metric is `Σ(coverage × intra_mac)` over all Stage-1 nuclei. When the 60 Hz mode (cov=0.6, mac=0.94, contrib=0.56) fragments into two cov=0.27 nuclei (mac~0.95 each), the contributions become:
- Original (consolidated): 1 nucleus × 0.6 × 0.94 = 0.564
- Fragmented: 2 nuclei × 0.27 × 0.95 ≈ 0.513 total

So fragmentation **directly costs ~0.05 in Q**. Combined with similar fragmentation of weaker modes (74 Hz, 50 Hz) on borderline configs, the total Q hit is ~0.2-0.4. **This is exactly the magnitude of the noise floor measured in S1 (Q std = 0.21).**

The "noise floor" we measured is not noise from the data — **it's deterministic algorithmic noise from window alignment.**

---

## E. Remediation options (research only, NOT for implementation)

Ranked by ease-of-implementation × predicted impact:

### **Option 1 — Halve the window step (overlapping windows).**

Change line 210 from `f_center += half_w` to `f_center += half_w / 2` (or `/ 3`).
With overlap, every detection falls in 2 (or 3) windows; greedy peeling assigns it to the first window that succeeds, but Stage-1 will succeed on the window where the cluster is centered, not split.

**Predicted impact:** eliminates ~80 % of the 60 Hz fragmentation cases. The remaining boundary-straddling cases get smaller windows that cluster cleanly.

**Risk:** **runtime cost is 2-3x** (twice as many windows tested), but each is a small SVD; total Stage-1 cost is small relative to ESPRIT itself. **Risk to correctness:** the same physical mode may be peeled into 2 nuclei from 2 different windows if the first one only catches a subset (the algorithm currently emits a nucleus once it finds ≥4 dets clustering tightly). This means **the behaviour gets DIFFERENT but not necessarily better** — needs Stage 2 to merge consistently. This is the deferred-to-Stage-2 strategy that the existing `_merge_nuclei_pairwise` is supposed to handle.

### **Option 2 — Two-pass: detect, then re-cluster boundary nuclei.**

After Stage-1 emits its nuclei, do a single re-clustering pass over (any pair of nuclei whose freq-mean differs by < 1 Hz). For pairs where MAC > 0.85, merge them. This is essentially Stage 2 already, but Stage 2 has additional gates (coverage × overlap matrix, damping) that may reject these legitimate same-mode merges in the LOW + LOW corner.

**Predicted impact:** if Stage 2 already merges these in production, the fragmentation we measured in Stage-1 only is irrelevant for the production pipeline. Need to verify by running the full nuclei_merge pipeline.

**Risk:** the harness only tests Stage-1; we don't know if Stage 2 fixes this. **This is the most important verification before changing anything** — see proposed follow-up below.

### **Option 3 — Use larger `nm_nucleus_window_pct` (wider windows).**

`nm_nucleus_window_pct = 0.03` means at f=100 Hz, half_w = 3 Hz. Increasing to 0.05 (5%) would still pin at the 3.0 Hz floor for ultra-low band. Increasing the floor `nm_nucleus_min_width` from 3.0 to e.g. 5.0 Hz would help: at 60 Hz the window becomes 10 Hz wide, large enough to absorb the entire 60 Hz cloud (3.7 Hz spread) plus margin.

**Predicted impact:** reduces fragmentation by widening the catch-all window. Same physical mode is more likely to fit in a single window.

**Risk:** wider windows admit MORE cross-mode contamination — the 60 Hz and 49 Hz clouds might end up in the same window, where hierarchical clustering then has to distinguish them. **At higher frequencies (other bands using the same TrackingConfig), this would break the relative width assumption.** Per-band `nm_nucleus_min_width` would be needed; currently it's a global config.

### **Option 4 — Anchor grid differently (e.g. use detection-density centroids).**

Instead of `f_center = f_min + k × half_w`, run a kernel density estimator over `freqs_arr` and place windows at the density peaks. This is the proper "find the modes" approach and is essentially what the `sliding_window` tracker tries.

**Predicted impact:** eliminates window-boundary alignment as a failure mode entirely.

**Risk:** much bigger algorithm change; would need rewrite of `_detect_nuclei`. Goes beyond a fix.

### **Option 5 — Ignore Stage-1 nucleus boundaries; only look at "real-mode" detections.**

Don't trust Stage-1's nucleus segmentation. Instead, define a "physical mode" as any consensus across N independent runs (the S4 strategy: a nucleus that appears in ≥3 of 5 sub-sample runs at the same freq). This is a metric change, not an algorithm change.

**Predicted impact:** much more stable Q metric, immune to single-run window-alignment artefacts.

**Risk:** requires changing the experimental harness to do bootstrap sampling on every parameter point. The production pipeline would not change; only the EVALUATION of which params are best changes.

---

## F. Recommended next step (NOT implementation)

**Verify whether Stage 2 of the production pipeline merges the fragmented Stage-1 nuclei.**

The harness only tested Stage-1 in isolation. The production `nuclei_merge` runs Stage-2 (`_merge_nuclei_pairwise`) and Stage-3 (`_assign_strays`) on top of Stage-1.

The two fragments at skip=15 are:
- f_mean=60.35, n=8, sc_set has 8 unique scenarios
- f_mean=60.72, n=8, sc_set has 8 unique scenarios (potentially overlapping with above? need to check)

`_merge_nuclei_pairwise` runs on these. Looking at `_merge_score`:
- `f_score`: |60.72-60.35| / 60.35 = 0.6 % → above any reasonable freq threshold (default `nm_merge_max_freq_diff_pct=0.05`=5%) → freq gate passes.
- MAC: both fragments have very similar shapes (the underlying physics is the same mode). MAC between their reference shapes is likely > 0.9.
- Coverage × overlap: combined_cov ≈ 0.5; overlap ≈ ? (depends on whether the 8+8 scenarios overlap or are disjoint).
  - If disjoint (skip=15 split the SCENARIOS not the dets-per-scenario): combined_cov ~ 0.5, overlap = 0 → **HIGH cov + LOW ovl = MERGE**. 
  - If overlapping: combined_cov < 0.5, overlap > 0.5 → maybe HIGH+HIGH NEVER MERGE corner. 

**If Stage 2 already correctly merges these fragments back, the Stage-1 fragility is a Stage-1-only concern that doesn't reach the production output.** The harness was measuring an artefact that doesn't manifest in production.

This must be verified before any change. A 2-minute experiment (run the FULL `nuclei_merge` pipeline at skip=15 vs skip=20 and compare the final chains) would definitively answer.

---

## G. Final recommendation (synthesis)

1. **Do not modify `mode_tracking_nuclei.py` yet.** The fragmentation we measured is in Stage-1, but Stage 2's merge logic is specifically designed to fix exactly this kind of split (HIGH-cov + LOW-ovl is the canonical "merge split chains" rule per the docstring).

2. **Verify the actual production-pipeline output** (run `track_modes_nuclei_merge` end-to-end at skip=15 vs skip=20 on the same data). If the final chains are stable across configs, Stage-1 fragility is irrelevant to production. If the final chains ALSO fragment, then we have a real algorithmic problem.

3. **Independently of the algorithm fix, the experimental harness should be revised:** the Q metric over Stage-1 alone is not a reliable optimization target because it's heavily contaminated by window-alignment artefacts. Use the full `nuclei_merge` output for any metric-driven parameter sweeping going forward.

4. **If verification shows Stage 2 does NOT merge the fragments,** Option 1 (halve the window step) is the lowest-risk fix worth prototyping, with a side-by-side comparison against the existing version on PlyWoodTake1 + at least one other dataset.

5. **The original Phase 2 conclusion stands:** the only defensible production-config change from this entire investigation is `ir_length_ms: 1000 → 600`. The Stage-1 fragmentation finding does not change that recommendation; it only refines our understanding of WHY individual parameter sweeps showed the noise floor they did.

---

## H. Files

- `tools/grid_search/investigate_stage1.py` — first focused trace
- `tools/grid_search/investigate_stage1_v2.py` — full window-by-window trace
- `tools/grid_search/investigate_stage1_v3.py` — quantification + synthetic shift
- `tools/grid_search/results/stage1_trace.log` — first trace output
- `tools/grid_search/results/stage1_trace_v2.log` — full trace
- `tools/grid_search/results/stage1_trace_v3.log` — quantification + synthetic
