# Stage-1 Fragmentation — Part A + Part C Verification (2026-05-07)

Follow-up to `dev-grid-stage1-fragmentation-analysis.md`. Two questions answered:

- **A.** Does Stage-2 of the production pipeline fix the Stage-1 fragmentation we measured?
- **C.** Does an overlapping-windows prototype of `_detect_nuclei` fix the fragmentation at the source?

**Both: NO.** Production has a real bug, and the overlap fix doesn't address it.

---

## A. Stage-2 verification

Ran `track_modes_nuclei_merge` end-to-end (Stage 1 + 2 + 3) at four configs sharing
`(ir=600, fin=20, fout=0, dec=4)`, varying only `skip_start_ms`. Two boundary-aligned
(15, 50) and two interior (20, 25).

### Final-chain output, 58-62 Hz region

| skip | Stage-1 nuclei in 60Hz | Final chains in 60Hz | merged? |
|--:|---|---|---|
| 15 (boundary) | f=60.35 (n=8) + f=60.72 (n=8) | f=60.35 (n=8) + f=60.82 (n=11) | **NOT MERGED** |
| 20 (interior) | f=60.54 (n=18) | f=60.72 (n=21) | (single nucleus all the way) |
| 25 (interior) | f=60.57 (n=20) | f=60.57 (n=20) | (single nucleus all the way) |
| 50 (boundary) | f=59.10 (n=8) + f=60.72 (n=11) | f=59.10 (n=8) + f=60.72 (n=11) | **NOT MERGED** |

### Why Stage-2 doesn't merge

Traced `_merge_score(fragment_a, fragment_b)` for skip=15 and skip=50:

```
skip=15:
  freq_diff_pct  = 0.60 %  →  f_score = 0.879  (gate passes: < 5%)
  damping_a      = 1.14 %
  damping_b      = 0.34 %
  damping_diff_pct = 237.9 %  →  decision = "reject_damping"
                                  (hard gate: nm_merge_max_damping_diff_pct = 100 %)

skip=50:
  freq_diff_pct  = 2.75 %
  damping_diff_pct = 200.1 %  →  decision = "reject_damping"
```

The merge is **rejected on the damping hard gate**, not on freq/MAC/coverage.

**Why is the damping difference so high?** Looking at the raw 60-Hz detections at
skip=15: all scenarios have damping ~0.05-1.5 % EXCEPT scenario 11 which has
damping=5.19 % (a clear ESPRIT outlier — same physical mode, but ESPRIT estimate
went wrong on that one scenario).

Fragment A captured scenarios `[4, 7, 11, 19, 23, 25, 26, 28]` — including scenario 11
with its 5.19 % damping outlier — pulling Fragment A's `damping_mean` to 1.14 %.
Fragment B captured the remaining 8 scenarios with normal damping → mean 0.34 %.
The 3.4× damping ratio violates the 100 % hard gate.

So **two independent algorithmic fragilities compound** to produce the production bug:

1. **Window-grid alignment** in Stage 1 splits the same physical mode into two fragments
   when the mode's freq cloud straddles a window boundary.
2. **Damping hard-gate** in Stage 2 (designed to distinguish genuinely different modes)
   over-rejects when one of the fragments captured a damping outlier from one bad
   ESPRIT estimate.

### Confirmation: production IS affected

The user's experimental observation that mode tracking seems noisy is now explained.
Configs where the dominant 60 Hz cloud center happens to align with a window boundary
will produce **two final chains** at ≈ 60 Hz instead of one. Downstream consumers see
"two modes" near 60 Hz — wrong physics.

Frequency-of-occurrence: 3 of 9 skip values tested (skip=0, 15, 50) align within 0.1 Hz
of a window boundary. That's 33 % of (skip×ir) configs producing fragmented final
output for the dominant mode.

---

## C. Overlapping-windows prototype evaluation

Created research-only `tools/grid_search/stage1_overlap_proto.py` with `_detect_nuclei_overlap`:
identical to production except `f_center += half_w / 2` (50 % overlap) instead of
`f_center += half_w`.

### S1 noise floor (10 runs at fixed `(skip=25, ir=600, fin=20, fout=0, dec=4)`)

| | Q std | Q median | Q range |
|---|---:|---:|---:|
| Production | 0.212 | 1.807 | 0.699 |
| Overlap | 0.211 | 1.770 | 0.698 |

**Q std improved by 0.4 % — within measurement noise. The overlap does not flatten the
noise floor.**

### S2 skip sweep (full 30 scenarios)

| skip | prod Q | overlap Q | diff % | prod 60Hz nuclei | overlap 60Hz nuclei |
|--:|--:|--:|--:|--:|--:|
| 0 | 1.277 | 1.277 | 0.0 % | 2 | 2 |
| 5 | 1.577 | 1.619 | +2.7 % | 1 | 1 |
| 10 | 1.687 | 1.554 | −7.9 % | 1 | 1 |
| **15** | 1.472 | 1.570 | +6.7 % | **2** | **2** |
| 20 | 1.906 | 1.899 | −0.4 % | 1 | 1 |
| 25 | 2.003 | 1.948 | −2.8 % | 1 | 1 |
| 30 | 1.761 | 1.686 | −4.3 % | 1 | 1 |
| 40 | 1.268 | 1.197 | −5.6 % | 1 | 1 |
| **50** | 1.510 | 1.531 | +1.4 % | **2** | **3** |

**Critical: skip=15 still fragments into 2 nuclei (max 8 dets each).
Skip=50 is WORSE under overlap — 3 nuclei instead of 2.**

The 60 Hz mode at skip=15:
- Production: 2 fragments (max=8 dets) — fragmentation
- Overlap: 2 fragments (max=8 dets) — same fragmentation

The 60 Hz mode at skip=50:
- Production: 2 fragments (max=11 dets)
- Overlap: 3 fragments (max=11 dets) — overlap added a NEW small fragment

### Why the overlap doesn't fix it

Greedy peeling still applies to the FIRST successful window. With overlap:

- Window k (centered at f_min + k × 1.5 Hz) sees N detections in [f_min + k × 1.5 - 3, f_min + k × 1.5 + 3].
- If clustering succeeds, those detections are marked `assigned=True`.
- Window k+1 (centered at f_min + (k+1) × 1.5 Hz, shifted by 1.5 Hz) now sees only the
  REMAINING unassigned detections.

When the 60 Hz cloud straddles a boundary like in skip=15:
- Window k catches 8 dets at f ≤ 60.51 — succeeds, those 8 marked assigned.
- Window k+1 (overlap), now only sees the OTHER 8 dets at f ≥ 60.53 — succeeds,
  forms second fragment.

**The overlap adds intermediate windows but does not change the fundamental greedy-peeling
order.** Each successful window cements its assignment regardless.

For overlap to actually help, the algorithm would need to **defer assignment**: try every
window first (without marking assigned), then pick the LARGEST/BEST cluster across all
windows that succeeded, then assign. That's a different algorithm.

---

## D. Verdict + remediation re-ranking

### Part A verdict: REAL PRODUCTION BUG

The Stage-1 fragmentation reaches production output. ~33 % of typical configs produce
two final chains for the dominant 60 Hz mode where there should be one.

The bug surfaces specifically when:
1. The dominant mode's frequency cloud center aligns with a Stage-1 window boundary
   (`(60_Hz_cloud_median - f_min_global) % 3.0 ≈ 0`), AND
2. One of the resulting fragments captures a damping-outlier ESPRIT detection
   (in the data: scenario 11 has ESPRIT damping=5.19% when the true damping is ~0.5%).

Both conditions co-occur for skip ∈ {0, 15, 50}. They don't co-occur for skip ∈ {5, 10,
20, 25, 30, 40}, which is why those configs produce stable single-mode output.

### Part C verdict: OVERLAP DOES NOT FIX IT

Adding overlapping windows alone is insufficient because greedy peeling cements the
assignment from the first successful window. The overlap creates more attempts but the
first one always wins.

### Re-ranked remediation options

**Option 1 (PRIORITISED — addresses the real bug at Stage 2):**

Soften the damping hard gate in Stage 2 from a binary 100 %-cutoff to a soft penalty.
Specifically in `_merge_score`:
```python
# Current:
if damping_diff is not None and damping_diff > config.nm_merge_max_damping_diff_pct:
    return 0.0, "reject_damping", components

# Proposed:
# Replace hard gate with soft penalty in the score
damping_penalty = min(1.0, damping_diff / config.nm_merge_max_damping_diff_pct)
score -= config.nm_merge_w_damping * damping_penalty
```

When the same physical mode fragments under Stage-1 alignment, freq+MAC will be very
close (skip=15: 0.6 % freq diff, MAC > 0.9). The damping penalty is then a
factor in the score but not a veto.

**Predicted impact:** the boundary-aligned skip configs would merge correctly; the Q
noise floor would drop from std=0.21 to something like std=0.10 (a real improvement).

**Risk:** the damping hard gate exists for a reason — to prevent merging two genuinely
different modes that happen to have similar shapes. Softening it may create false
merges in datasets where modes are densely packed in frequency. Requires validation
on Belarus or another dataset before adoption.

**Option 2 (DEFERRED — the original Option 1 from the previous analysis):**

Window overlap with deferred assignment. Instead of marking detections assigned
inside the window loop, accumulate ALL successful clusters across all windows, then
do a global pass: for each detection, pick the BEST cluster (size, tightness) and
assign once. This is a bigger algorithmic change but addresses the root cause in
Stage 1 directly, without depending on Stage 2 to clean up.

**Predicted impact:** more thorough fix; eliminates Stage-1 fragmentation as a class.

**Risk:** larger algorithm change; needs careful testing of the global-assignment
heuristic.

**Option 3 (CHEAP — work around at the parameter level):**

Document that production users should avoid `skip_start_ms` values that align
`f_min_global + k × 3.0` with the dominant modes' frequency clouds. In practice
this means avoiding skip values that produce `(f_60Hz_median - f_min) % 3.0 ≈ 0`.
But `f_min_global` depends on the dataset, so this can't be specified statically.

**Predicted impact:** workaround only; doesn't fix the algorithm.

---

## E. Updated path forward

1. **The Phase 2 production-defaults recommendation is unchanged:** still
   `ir_length_ms: 1000 → 600` only. The Stage-1 + Stage-2 bug doesn't affect that
   recommendation.

2. **NEW production change to consider:** soften `nm_merge_max_damping_diff_pct`
   from a hard gate (100 %) to a soft penalty in `_merge_score`. This requires
   careful validation on a second dataset.

3. **The harness's "noise floor" finding stands:** Q std=0.21 is the right
   characterization of run-to-run variance under scenario subsetting. The overlap
   prototype confirmed this is NOT specifically a Stage-1 artefact — it's a deeper
   property of the data + Stage-1 + Stage-2 + Stage-3 combination.

4. **Defer further algorithmic changes** until a second dataset is validated.

---

## F. Files (research only, no production code touched)

- `docs/development/logs/dev-grid-stage1-fragmentation-followup.md` — this file
- `tools/grid_search/verify_stage2.py` — Part A end-to-end test
- `tools/grid_search/verify_stage2_score.py` — Part A score trace
- `tools/grid_search/results/verify_stage2.log` + `verify_stage2_score.log`
- `tools/grid_search/stage1_overlap_proto.py` — Part C overlap prototype (research copy)
- `tools/grid_search/run_overlap_eval.py` — Part C evaluation harness
- `tools/grid_search/results/overlap_eval.log` — Part C output

`mode_tracking_nuclei.py` and `mode_tracking.py` UNCHANGED. No production commits.
