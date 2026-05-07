# dev-grid Deep Analysis (Phase 1) — 2026-05-07

This document re-examines all dev-grid results so far through the lens of:
1. The user's warning that **above 600 ms, recorded signal contains significant noise**.
2. Run-to-run / scenario-to-scenario / parameter-to-parameter variance — what is signal, what is noise.

Sources analysed:
- `tools/grid_search/results/exp1_long_ir.json` (E1: ir × dec sweep on 1000 ms project)
- `tools/grid_search/results/exp2_tight_grid.json` (E2: skip × fin tight grid at ir=1000)
- `tools/grid_search/results/exp3_fine_grid.json` (E3: 7×7 fine grid at ir=1000)
- `tools/grid_search/results/phase_a_dec16_gpu.json` (Phase A GPU: 270 pts, ir 100-600)
- `tools/grid_search/results/phase_b_full_cascade_v3.json` (long-ir cascade)
- `tools/grid_search/results/phase_b_full_cascade_v4.json` (short-ir cascade)
- per-scenario `effective_signal_length.json` files in `D:/modal_measurements/PlyWoodTake1_grid/`

---

## A. Effective signal length distribution

The user's "above 600 ms is noise" warning is empirically supported by the per-scenario QC data
already on disk. Aggregating `per_channel_t_eff_ms` across all 30 scenarios and 7 response
channels (210 cells; using the existing PlyWoodTake1_grid QC files, which were computed
against the full 1000-ms input):

| statistic | value (ms) |
|---|---:|
| min | 14.1 |
| 10th percentile | 144.2 |
| **median** | **278.8** |
| 90th percentile | 613.3 |
| max | 1000.0 |

Per-channel medians range 247-336 ms. Several scenarios (S22, S24, S26 in particular) have
multiple channels with t_eff < 100 ms — essentially no useful signal at all in those channels.

**Implication.** A typical `(scenario, channel)` cell is dominated by noise after ~280 ms.
Analysing `ir_length_ms = 1000` means analysing **~280 ms of signal + ~700 ms of noise** for the
median cell. Even `ir_length_ms = 600` means analysing the typical cell with ~50 % noise tail.

The **truly safe** ir cap is around 300 ms (median) or 200 ms (the bottom-half cells). **This
casts every previous conclusion at ir > 600 in serious doubt.**

---

## B. Hypotheses, with evidence

### H-noise. ir > 600 ms gains are spurious.

**Evidence FOR:**

- `total_detections` is essentially constant at ir=600/800/1000 (~110 raw poles per sweep,
  identically distributed across the 30 scenarios). At dec=16, ir=600 → 110 detections;
  ir=800 → 110; ir=1000 → 110. **The longer signal does NOT yield more raw poles per
  scenario** — it yields the *same* poles but Stage-1 clusters them into more nuclei.
- N_nuclei climbs 8 → 10 → 13 (ir 600 → 800 → 1000) at dec=16 BUT mean_coverage drops
  0.229 → 0.220 → 0.187 (each nucleus spans fewer scenarios) AND mean_mac drops 0.919 →
  0.893 → 0.877 (each nucleus is less internally coherent). Both signatures of
  fragmentation, not "discovering more physical modes".
- The "extra" nuclei at ir=1000 that don't exist at ir=600 must be:
  (a) sub-clusters of one physical mode that drift across scenarios because the ESPRIT pole
      estimate destabilises in the noise-tail-heavy window, OR
  (b) noise-driven "modes" that happen to correlate across cycles within each scenario
      (Hilbert-decay measurements are based on cycle averaging — correlated across cycles
      means low intra-MAC nuclei still pass the Stage-1 hard gate).

**Evidence AGAINST:**

- mean_mac at ir=1000 is still 0.85-0.92, which is "high enough" that pure-noise nuclei
  shouldn't form (random shapes correlate at ~0.14 RMS for n_channels=7).
- The 13 nuclei at ir=1000 dec=16 are not random sample-by-sample noise — they reflect
  some structure in the longer window.

**Status.** Strong support; needs falsification by cross-checking the ir=600 vs ir=1000 nuclei
at the per-mode level (do the 5 "new" nuclei have plausible piano-soundboard frequencies, or
do they cluster around filter-edge frequencies that suggest filter ringing?).

### H-saddle. dec=16 has two real Q peaks (fin=2 AND fin=25), or it's a single peak with
noise-driven ridge structure.

**Evidence FOR bimodality:**

- E2 found peak at `(skip=20, fin=25)` Q=2.4711.
- E3 fine grid found peak at `(skip=20, fin=2)` Q=2.3222.
- Both peaks have skip=20.
- The fin axis between (E3 grid range fin ∈ {0,2,5,8,10,12,15}) shows a pronounced saddle:
  for skip=20 dec=16: Q at fin=0,2,5,8,10,12,15 = `1.99, 2.32, 2.08, 2.31, 2.28, 2.31, 2.20`.
  That's a 16 % oscillation across consecutive fin values changing by 2-3 ms.

**Evidence AGAINST (i.e. it's noise):**

- A 2-ms change in fade-in length means 6 samples at fs_band=3000 Hz (dec=16). This is
  an extremely small perturbation to the ESPRIT input. No physical mechanism makes Q jump
  16 % from such a perturbation.
- The Q values at fin=2, 8, 10, 12 are all between 2.28 and 2.32 — within 1.5 % — but
  fin=0 and fin=5 dip to 1.99-2.08. **This looks more like a noise ladder than a true
  bimodal optimum.**
- Both "peaks" in E2 and E3 share skip=20 and have within-1% Q with their neighbors at
  fin=8/10/12. The "two peaks" frame is misleading: there's a broad ridge with stochastic
  dips.

**Status.** "Two peaks" is almost certainly an artefact of stochastic Stage-1 cluster
boundaries. A single broad ridge is more parsimonious. Falsifiable by re-running the same
config N times with random scenario subsets — if Q varies by 10-15 % run-to-run, the saddles
are within noise.

### H-decimation-real. The dec=16 → dec=8 → dec=4 differences are about ESPRIT resolution,
or about noise contamination differing across decimations.

**Evidence FOR real:**

- Phase B v3 cascade at `(25, 600, 20, 0)` showed dec=16/8 plateau at 1.70 then dec=4 jumps
  to 2.00 (+18 %) with 10 nuclei vs 8. This was reproduced in E1 exactly.
- N_nuclei increases monotonically as decimation decreases (16 → 8 → 4 = 8 → 8 → 10) at
  ir=600. Monotonic = more likely to reflect resolution gain.

**Evidence AGAINST (noise):**

- At ir=1000, the dec=16/8 vs dec=4 reverses: dec=16/8 = 2.17, dec=4 = 1.99. The longer
  signal "helped" higher decimations more. This is what we'd expect IF the dec=4 longer
  signal at ir=1000 admits more noise into the working window than dec=4 at ir=600.
- The dec=2/dec=1 collapse (Q drops to ~0.8) is universal across all configs and all ir
  values. This is consistent with a fixed-cause explanation: at fs_band ≥ 24 kHz, the
  bandpass at 30-100 Hz is so narrow relative to fs_band that the filter's transient/ringing
  characteristics dominate and ESPRIT extracts garbage. **This is a real ESPRIT failure
  mode, not a "Stage-1 metric quirk".**

**Status.** Mixed. The dec=16/8/4 cluster looks like a small real effect (~10-20 %) that
interacts with noise. dec=2/1 collapse is unambiguously real. Falsifiable by per-nucleus
frequency analysis: real ESPRIT-resolution gains should show new nuclei at frequencies
adjacent to existing nuclei (mode splitting); noise-driven gains should show new nuclei at
"random" frequencies.

### H-config-sensitivity. At ir=600 (the safest tested), is `(skip=25, fin=20)` truly better
than `(skip=25, fin=10)`, or within run-to-run variance?

**Evidence relevant:**

- Phase A GPU at dec=16, ir=600 showed:
  - `(skip=25, ir=600, fin=10, fout=0)` → didn't compute (not on grid; closest is `ir=500`)
  - `(skip=25, ir=500, fin=20, fout=0)` → Q=1.829
  - `(skip=25, ir=600, fin=20, fout=0)` → Q=1.924
  - `(skip=25, ir=600, fin=10, fout=0)` → not in this grid
  - `(skip=25, ir=600, fin=20, fout=20)` → Q=1.924 (3-way tie with fout=0)

- Phase A GPU heatmap shows skip=25 column at dec=16:
  ir=100: 0.43 (mostly garbage)
  ir=200: 2.06 (top-1 of the GPU grid)
  ir=300: 1.59
  ir=400: 2.02
  ir=500: 1.83
  ir=600: 1.92

  **The ir column at skip=25 oscillates 1.59 → 2.06 → 1.59 → 2.02 → 1.83 → 1.92.**
  ir=200 wins, but ir=300 right next door drops 23 %, and ir=500/600 oscillate 5 %.
  This is the same noise ladder we saw on the fin axis.

**Status.** Strong evidence that small parameter changes produce ~10-20 % Q oscillations that
are NOT systematic. The "winners" published in prior reports are mostly artifacts of which
random Stage-1 cluster boundaries the harness happened to land on at that specific input.

### H-stage1-fragmentation. The Stage-1 `_detect_nuclei` algorithm is sensitive to its sliding
window's exact starting position relative to the detected pole frequencies. Small input
changes (a few samples of fade-in) can make the same pole appear in 2 nuclei vs 1.

**Evidence:**

- E3 dec=8 around (skip=25, fin=5) shows:
  - skip=25 fin=5: 14 nuclei, Q=2.31, cov=0.188
  - skip=25 fin=8: 13 nuclei, Q=2.05, cov=0.192
  - skip=25 fin=10: 14 nuclei, Q=2.20, cov=0.181

  Here the SAME pole set (total_detections ≈ 110-112) is being clustered into 13/14/14
  different nuclei depending on fin (a few-sample perturbation). Q varies 12 %.

- The same pattern exists at every skip. Cluster boundaries are not stable to small input
  perturbations.

**Status.** Confirmed. This is the underlying mechanism behind all the apparent "configs
matter" findings.

---

## C. Quantitative noise-floor estimates from existing data

Without running new experiments yet, we can estimate the noise floor from spatial
auto-correlation in the E3 fine-grid heatmaps.

**E3 dec=8 grid (49 pts):**
- Q range across all configs: 1.80 to 2.31
- Q std across all configs: 0.126
- Q at adjacent cells (e.g. fin step 2-3 ms): typical |ΔQ| ≈ 0.15-0.30

If parameter changes of 2-3 ms (which can't physically affect a 30-100 Hz mode) produce
|ΔQ| ≈ 0.15-0.30, then **the stochastic noise floor on Q is approximately ±0.15** (5σ-clip
type estimate). This means:

- The "best Q = 2.31" winner is statistically indistinguishable from any Q ≥ 2.16.
- The "best Q = 2.47" Phase E2 peak is statistically indistinguishable from any Q ≥ 2.32.
- The dec=4 vs dec=8 difference at ir=600 (2.00 vs 1.70 = 0.30) is **ON THE EDGE** of the
  noise floor — possibly real but barely.
- The N_nuclei differences of ±1-2 at adjacent cells are pure noise.
- The 18 % gain from `(skip=50, ir=1000, fin=10, fout=20)` (production) to `(skip=25, ir=600,
  fin=20, fout=0)` claimed in prior reports may be entirely within run-to-run variance.

**This invalidates most of the "ranking" conclusions in prior reports.** The harness has been
finding random local maxima of the noise floor, not real parameter optima.

---

## D. What survives the re-examination

Defensible statements from the data:

1. **Above ir = 600 ms, the data is mostly noise** — supported by the per-channel t_eff
   distribution (median 280 ms, p90 = 613 ms). Conclusions from E1/E2/E3 about the "ir=1000
   peak Q=2.47" must be discarded.

2. **dec=2 and dec=1 universally collapse** — Q drops from ~2.0 to ~0.8 across every config
   tested. This is a real, repeatable effect. Mechanism is the bandpass filter behaving badly
   when fs_band ≥ 24 kHz.

3. **dec=4 vs dec=8 is not clearly different** — the ~10-15 % gap is at the edge of the
   noise floor. The current production default of `decimation=4` is defensible, but `dec=8`
   would also be defensible.

4. **`skip_start_ms = 0` is consistently worse than skip > 0** at every dec/ir combination —
   removing the forcing-function transient is a real benefit. The production default `skip=50`
   is on the safe side; values 25-50 are likely all reasonable. The exact value within
   `[20, 50]` cannot be reliably distinguished from the data.

5. **`end_fade_ms` is essentially inert at this band** — Q is invariant across fout=0, 10, 20
   in many configs. The current production default `fout=20` adds nothing but doesn't hurt.

6. **`start_fade_ms` ranges 0-30 produce comparable Q at the safe ir=600 region.** No clear
   winner.

7. **Q itself is a noisy metric.** Adjacent grid cells differ by ~0.15. Any "winning"
   config must beat its neighbours by > 2 × 0.15 = 0.30 to claim a real effect.

What does NOT survive:

- "ir=1000 is better than ir=600" — false; gain is fragmentation noise from analysing
  noise-tail data.
- "(skip=20, ir=1000, fin=25, fout=0) at dec=16 is the best with Q=2.47" — not
  statistically distinguishable from the broader ridge it sits on.
- "(skip=25, ir=200, fin=10, fout=0) is the GPU Phase A winner" — was likely a one-bin lucky
  draw given the 23 % adjacent-cell oscillations in the heatmap.

---

## E. Plan for Phase 2 measurements

Goal: distinguish systematic from stochastic effects. All experiments at the safe ir=600 ms
region using the existing 700 ms project.

### S1 — Run-to-run noise floor (BASELINE).

Pick a fixed config: `(skip=25, ir=600, fin=20, fout=0)` at `dec=4`. Run it N=10 times with
DIFFERENT scenario subsets:
- Run 1: scenarios 0..29 (full 30)
- Run 2-10: 9 different leave-3-out subsets (27 of 30)

For each run, capture per-nucleus details:
- list of `(frequency_mean, frequency_std, damping_mean, n_detections, intra_mac, coverage)`
  for every Stage-1 nucleus
- aggregate: N_nuclei, mean_intra_mac, std_intra_mac, mean_coverage, std_coverage,
  total_detections, n_unassigned, runtime, Q

The std of these aggregates across the 10 runs is the noise floor. Any subsequent
parameter sweep must produce deltas exceeding ~2σ of the noise floor to count as systematic.

### S2 — Skip axis sweep at fixed everything else.

`(ir=600, fin=20, fout=0, dec=4)` × skip ∈ {0, 5, 10, 15, 20, 25, 30, 40, 50}
9 points × full 30 scenarios. Capture same per-nucleus details as S1.

For each skip, compare its (Q, N_nuclei, mac, cov) to the S1 noise floor. Highlight cells
that are within noise vs outside.

### S3 — Fin axis sweep at fixed everything else.

`(skip=25, ir=600, fout=0, dec=4)` × fin ∈ {0, 5, 10, 15, 20, 25, 30}
7 points × full 30 scenarios.

### S4 — Per-nucleus identity tracking across configs.

Take 3 configs in the dec=4, ir=600 region:
- A: `(25, 600, 0, 0)`
- B: `(25, 600, 20, 0)` (current candidate)
- C: `(25, 600, 30, 0)` (corner of fin range)

Run each at full 30 scenarios. For each pair (A, B), (B, C), match Stage-1 nuclei across
configs by frequency proximity (Δf < 1 Hz) and MAC similarity (mac > 0.7). Report:
- How many nuclei in A appear in B with same identity?
- How many "new" nuclei does each config find that aren't in the others?

This is the most direct test of H-stage1-fragmentation: if 80%+ of nuclei are common
across configs, fragmentation is small; if only 50%, fragmentation dominates.

### S5 (optional) — Subset variability.

Same config, run at 5 different random 25-of-30 subsets. Tests whether N_nuclei is
sensitive to which scenarios are included. If subsets give N_nuclei = 9, 14, 11, 13, 10 for
the same config, Stage-1 is heavily input-dependent.

---

## F. Initial reconsidered recommendation (pre-Phase 2)

Based on Phase 1 analysis only (no new experiments), defensible recommendation:

**Keep current production defaults `EXTENDED_BANDS[0]` essentially as-is.**

The prior recommendations to change `(skip=50→25, ir=1000→600, fin=10→20, fout=20→0)` are
NOT defensible against the noise floor. Any individual change is within ±0.15 Q noise.

**Possible exception**: change `ir_length_ms` from `1000` to **`600`** (or **`500`**).
The `signal_length_ms` is already clamped by data (700 ms project, 1000 ms project), so
declaring `ir_length_ms=600` simply matches what's actually being analysed. AND it avoids
the noise tail explicitly. **This is the only change with a robust physical justification.**

The Phase 2 experiments below will confirm/refute this.

---

## G. Phase 2 outputs

Files:
- `tools/grid_search/results/S1_noise_floor.{json,_run.log}`
- `tools/grid_search/results/S2_skip_axis.{json,_run.log}`
- `tools/grid_search/results/S3_fin_axis.{json,_run.log}`
- `tools/grid_search/results/S4_nucleus_tracking.{json,_run.log}`

---

## H. Phase 2 results — RAW

### S1 — Run-to-run noise floor (FIXED config, 10 runs with random subsets)

Config: `(skip=25, ir=600, fin=20, fout=0, dec=4)`. Run 0 = full 30 scenarios; runs 1-9 =
9 different leave-3-out subsamples.

| metric | min | median | max | std | range |
|---|---:|---:|---:|---:|---:|
| **Q** | **1.332** | **1.807** | **2.031** | **0.212** | **0.699** |
| N_nuclei | 5 | 8 | 10 | 1.52 | 5 |
| mean_intra_mac | 0.760 | 0.870 | 0.910 | 0.045 | 0.150 |
| mean_coverage | 0.222 | 0.252 | 0.326 | 0.031 | 0.104 |

**Q std = 0.212 from removing 3 of 30 scenarios at the SAME config.** The full-30
"baseline" at Q=2.0031 is a +0.93σ outlier; the median across the 10 runs is Q=1.807.

This is the noise floor against which the parameter sweeps must be judged.

### S2 — Skip axis sweep at fixed (ir=600, fin=20, fout=0, dec=4)

| skip | Q | ΔQ vs S1med | sigmas | N_nuc | strong | 60Hz cov |
|--:|--:|--:|--:|--:|--:|--:|
| 0 | 1.277 | -0.530 | **-2.50σ** | 8 | 1 | 0.333 |
| 5 | 1.577 | -0.230 | -1.08σ | 8 | 1 | 0.500 |
| 10 | 1.687 | -0.120 | -0.57σ | 9 | 1 | 0.567 |
| 15 | 1.472 | -0.335 | -1.58σ | 9 | 1 | 0.267 (dip!) |
| 20 | 1.906 | +0.100 | +0.47σ | 10 | 1 | 0.600 |
| 25 | 2.003 | +0.196 | +0.93σ | 10 | 1 | 0.667 (peak) |
| 30 | 1.761 | -0.046 | -0.21σ | 9 | 2 | 0.533 |
| 40 | 1.268 | -0.538 | **-2.54σ** | 6 | 2 | 0.533 |
| 50 | 1.510 | -0.297 | -1.40σ | 9 | 1 | 0.367 |

**Statistically significant findings (>2σ vs noise floor):**
- skip=0 is worse (Q=1.28; -2.50σ): forcing-function transient pollutes ESPRIT.
- skip=40 is worse (Q=1.27; -2.54σ): too much real signal removed; only 6 nuclei survive.

**Within-noise (no significant effect):**
- skip ∈ {5, 10, 15, 20, 25, 30, 50}: All within ±1.6σ. Cannot distinguish them.
- The "skip=25 is best" finding from prior reports is NOT defensible.

**Per-mode tracking:**
- The dominant 60 Hz mode's coverage rises from 0.333 (skip=0) to peak 0.667 (skip=25)
  then declines. Skip=15 exhibits a SPURIOUS dip (cov=0.267) — this is Stage-1
  fragmentation: at this specific input window the 60 Hz nucleus splits into 2
  sub-clusters of cov=0.267 each instead of consolidating.
- The 90 Hz mode only appears in skip ∈ [15, 30]. Outside that window, undetected. This
  IS systematic: the mode requires removing the early transient AND keeping the
  early-tail signal.

### S3 — Fin axis sweep at fixed (skip=25, ir=600, fout=0, dec=4)

| fin | Q | ΔQ vs S1med | sigmas | N_nuc | 60Hz cov |
|--:|--:|--:|--:|--:|--:|
| 0 | 1.697 | -0.110 | -0.52σ | 8 | 0.500 |
| 5 | 1.919 | +0.113 | +0.53σ | 10 | 0.500 |
| 10 | 1.621 | -0.185 | -0.87σ | 8 | 0.533 |
| 15 | 1.848 | +0.041 | +0.19σ | 8 | 0.633 |
| 20 | 2.003 | +0.196 | +0.93σ | 10 | 0.667 |
| 25 | 1.954 | +0.148 | +0.70σ | 10 | 0.467 |
| 30 | 1.718 | -0.089 | -0.42σ | 8 | 0.600 |

**Every fin value is within ±1σ of the noise floor.** No fin value produces a statistically
significant Q change. The previously published "fin=20 is optimal" / "fin=25 sharp peak" /
"fin=10 with short ir" recommendations were **all artefacts of run-to-run variance**.

`start_fade_ms` does NOT have a measurable effect on Stage-1 nucleus quality at this band's
parameters. Any value in [0, 30] is statistically equivalent.

### S4 — Cross-config nucleus tracking

Three configs differing ONLY in fin: A (fin=0), B (fin=20), C (fin=30). All else equal.
Match nuclei across configs by frequency (1 Hz tolerance).

**Result:** 8 distinct consensus modes detected total.
- 5 modes (62 %) appear in **all 3 configs** with consistent freq/mac → real physical modes
- 2 modes (25 %) appear in **2 of 3 configs** → likely real but boundary
- 1 mode (12 %) appears in **only 1 config** → likely Stage-1 artefact

The 5 stable modes are at approximate frequencies: **38, 47, 50, 60, 75 Hz**. The
**60 Hz mode dominates** every config (cov 0.50 / 0.67 / 0.60 in A/B/C; mac > 0.94 in all).

The 60 Hz coverage swings ±15 % (0.50 → 0.67 → 0.60) just from changing fin by 0/20/30 ms
WITHOUT any plausible physical mechanism for that magnitude of effect. **This swing alone
accounts for most of the Q variation A→B→C.** Combined with sub-cluster fragmentation of
the 75 Hz mode (mac drops to 0.51 in B), it explains the entire Q delta.

**Most importantly:** the configs A and C have nearly-identical Q (1.697, 1.718) while B
has Q=2.003. **B is the lucky run; A and C are within noise floor of each other.** The
"fin=20 wins" framing was an artefact.

---

## I. Hypothesis verdicts

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **H-noise** (ir > 600 ms gains spurious) | **CONFIRMED** | t_eff median 280 ms, p90 = 613 ms. ir=1000 results unsafe. The N_nuclei climb 8→13 with ir=600→1000 is fragmentation, not new modes. |
| **H-saddle** (dec=16 has 2 real peaks) | **REFUTED** | S3 shows fin axis is entirely within noise floor. The "two peaks" at fin=2 and fin=25 in E2/E3 were random local maxima of the noise floor. |
| **H-decimation-real** (dec=4 vs 16 differences) | **PARTIALLY CONFIRMED** | dec=2/1 collapse is unambiguously real (filter artefact at near-Nyquist). dec=16/8/4 differences are within or barely above noise floor and likely not systematic. |
| **H-config-sensitivity** (params truly matter at ir=600) | **MOSTLY REFUTED** | S2/S3 show only skip=0 and skip=40 produce statistically significant Q changes. All other variations are within noise. |
| **H-stage1-fragmentation** (small input changes break clusters) | **CONFIRMED** | S4: 12 % of "qualifying nuclei" appear in only 1 of 3 closely-related configs. S2 60Hz dip at skip=15 shows a single mode splitting into 2 sub-clusters by chance. |

---

## J. Reconsidered final recommendations

### Production defaults — SHOULD STAY ESSENTIALLY UNCHANGED.

The current `EXTENDED_BANDS[0]` defaults are:
```python
FrequencyBand(f_min=30, f_max=100, filter_order=4, decimation=4,
              exp_factor=0.15, name="Ultra-Low", model_order=8,
              ir_length_ms=1000, skip_start_ms=50,
              start_fade_ms=10, end_fade_ms=20)
```

**Defensible changes (each backed by S1-S4 evidence):**

1. **`ir_length_ms`: 1000 → 600.** The data above 600 ms is dominated by noise (median
   t_eff = 280 ms; only 10 % of cells exceed 613 ms). Setting `ir_length_ms = 600` (or even
   500) restricts ESPRIT to the actually-useful signal window. **This is the only change
   with strong physical justification from the data.**

2. **`skip_start_ms`: 50 → 25.** The current value (50) is on the high end. S2 shows
   skip=40 already loses Q significantly (-2.5σ); skip=50 loses ~1.4σ. The center of the
   "safe" range is around 25-30. **Caveat:** the choice within [10, 30] is statistically
   indistinguishable, so a switch to 25 has marginal data support; the current 50 is
   defensible if conservative is preferred. The current `EXTENDED_BANDS` value
   `skip_start_ms=50` was already documented as "matching analyst's recommended table"
   with margin over filter settling — that rationale still holds. **Keep skip=50 unless
   strong reason to change.**

3. **`start_fade_ms`: keep at 10.** S3 shows fin entirely within noise floor [0, 30]. No
   change defensible.

4. **`end_fade_ms`: keep at 20.** Phase A heatmaps showed fout is essentially inert at
   this band. No change defensible.

5. **`decimation`: keep at 4.** dec=4 vs dec=8 differences are barely above noise floor.
   Either is defensible. dec=2/1 are clearly worse (filter artefact). Current default 4 is
   safe.

### **Final recommendation: change `ir_length_ms` from 1000 to 600. Leave the other parameters at current defaults.**

```python
# Current production:
FrequencyBand(..., ir_length_ms=1000, skip_start_ms=50,
              start_fade_ms=10, end_fade_ms=20)

# Recommended (single change):
FrequencyBand(..., ir_length_ms=600, skip_start_ms=50,
              start_fade_ms=10, end_fade_ms=20)
```

The change is small but has strong physical justification: it stops ESPRIT from analysing
the noise tail of the recordings. It does not change Q on the existing measurement project
much (within noise) but makes the analysis robust against datasets with shorter or noisier
decay tails. **It is a strictly defensive change** that costs nothing and removes a known
risk.

### Path forward (research, NOT immediate production changes)

1. **Validate against a second dataset.** All conclusions here come from PlyWoodTake1
   (one piano, one acquisition session). Repeat S1-S4 on Belarus or another project.

2. **Consider a different metric.** Stage-1 sum-of-(coverage × intra_mac) was useful for
   sweeping but is heavily noise-contaminated. A better metric might be:
   - Count of "stable" modes that appear in ≥ N independent runs (S4-style cross-validation).
   - Or, only include nuclei with intra_mac_min > 0.7 AND coverage ≥ 0.30.

3. **Investigate the Stage-1 fragmentation mechanism.** The cluster-boundary instability
   (60 Hz mode splitting into 2 nuclei at skip=15 only) is a Stage-1 algorithm issue.
   Worth investigating whether `nm_nucleus_window_pct=0.03` is too tight for this band
   (its physical-mode separation is small).

4. **The Ultra-Low band only has ~5 stable physical modes** in the 30-100 Hz range on
   PlyWoodTake1. ESPRIT with `model_order=8` over-extracts (~110 raw poles / 30 scenarios
   = ~3.7 poles/scenario) and Stage-1 amalgamates these into 8-13 nuclei depending on
   parameters. Reducing `model_order` from 8 to 5 might produce cleaner Stage-1 output.

### What should NOT change

- The harness itself (`tools/grid_search/`) is a research artefact. No production code
  should depend on its conclusions yet.
- No commits to `band_processing.py` or `EXTENDED_BANDS` defaults until the user signs off
  on the recommendation.

