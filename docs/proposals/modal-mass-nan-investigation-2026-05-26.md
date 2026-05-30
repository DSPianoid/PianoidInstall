# Modal Mass NaN Investigation — LG_p3 (ana-mmnan-7c3a, 2026-05-26)

## TL;DR

The user reported "371 NaN `m_relative` out of 757 chains (~49 %)" in the
modal mass output for project `LG_p3`. The audit of the existing persisted
data confirms the count and finds **no bugs**: every NaN is the architecturally
correct refusal-to-fit, propagated through three documented gates.

| Bucket | Count | What it means |
|---|---:|---|
| **A. VALID** — finite `m_absolute` + `m_relative` | **386** | Inversion succeeded, shape and mass payload usable. |
| **B. NaN — kernel refused every (sc,ch)** | **242** | Every per-scenario, per-channel circle-fit returned `0+0j` because the FRF band held < `MIN_FIT_BINS = 8` bins. The orchestrator's zero→NaN mask then drains the SVD tensor; the kernel raises `RuntimeError("No mode produced a valid mass estimate")`, caught at line 610 of `modal_mass_orchestrator.py`. Output `m_absolute = null`. |
| **C. NaN — no mapped full row** | **126** | Some `(scenario, channel)` cells produced nonzero residues, but no actuator-mapped scenario had **all 7** response-channel residues nonzero. `shape_inversion.py` requires `row_finite.all(axis=1)` per actuator row, so zero rows survive the row-completeness filter. |
| **D. NaN — only-unmapped full row** | **3** | The only scenarios where every channel succeeded are synthetic indices (5001, 5000, 5004) absent from `point_coordinates`. The orchestrator drops them at line 581-584 as "scenario not in current grid mapping". |
| **TOTAL** | **757** | 386 VALID + 242 + 126 + 3 = 371 NaN. Matches user's count. |

No category-D bugs (in the original-dispatch sense — i.e. "finite-data bug").
Buckets B, C, D are all architectural consequences of documented gates, not
defects in the persisted payload. The reference chain (id 312, 867 Hz)
correctly has `m_relative == 1.0`. Index ↔ per-chain field consistency is
perfect (0 mismatches across 757 chains × 5 cross-checked fields).

The **one architectural improvement worth flagging** for /dev follow-up: in
bucket C/D the chain payload carries a misleading-positive
`fit_quality_overall > 0` (median 0.17 across these 129 chains) and visible
per-scenario residues, yet `m_absolute = null`. The user/UI sees "this chain
had fitting work happen" but no mass — without a dedicated reason field this
is hard to explain. Recommended: add a string `mass_inversion_status` field
to the chain payload (`"valid"`, `"no_data"`, `"no_full_row"`,
`"unmapped_full_row"`). This is small (S; ~40 LOC backend + one frontend
chip).

The high NaN-rate is **also expected** at this project scale: LG_p3 has 757
tracked chains across 159 scenarios with 180 actuators — many high-modal-
density bands where the SDOF/MDOF kernels' `MIN_FIT_BINS` and cluster-cap
gates correctly refuse to fit. The Phase 2 verification on the smaller
PlyWoodLGtemp1 project (126 chains / 12 scenarios) already called out this
behaviour ("most low-`f` SDOF chains have `fit_quality = 0` because their
narrow band has fewer than `MIN_FIT_BINS = 8`" — IMPROVEMENT-PLAN line 884).
LG_p3 just scales the same dynamic up by 6× — including ~1.4× as many
chains-per-scenario, which raises the chance of MDOF cluster overflow into
`low_density_unresolved`.

Tuning levers (Phase 1 analysis below): lowering `MIN_FIT_BINS` from 8 to 5
or 4 would salvage some bucket-B chains at the cost of noisier circle fits;
raising `MDOF_CLUSTER_CAP` from 4 to 6 would salvage some bucket-C chains
(the 129 `low_density_unresolved`-classified ones) at the cost of slower /
worse-conditioned MDOF fits. Neither change is recommended without a
controlled before/after measurement of `m_relative` self-consistency — out of
scope for this audit.

---

## Method

* **Source data:** `D:/modal_projects/LG_p3/modal_adapter/modal_mass/` —
  the persisted Phase-2 output (757 `chain_<id>.json` files + one
  `index.json`).
* **Audit script:** `docs/development/diagnostics/ana-mmnan-7c3a-audit.py`
  (read-only; no live recompute).
* **Mapping reference:** `D:/modal_projects/LG_p3/project.json` →
  `measurement_snapshot.mapping_config.point_coordinates` (used to identify
  which scenario indices the orchestrator was prepared to map to actuator
  axes).
* **No backend started.** Scope refinement from the coordinator narrowed
  Phase B (live re-run) out — the on-disk artefact is the ground truth.

---

## Static analysis — where NaN can enter

The full path from "tracked chain" to "persisted `m_relative`" runs through
the three modules + the orchestrator. The decision tree below enumerates
every kernel guard that can produce a `0+0j` residue or block the SVD
inversion.

### Per-(scenario, channel) circle-fit / RFP fit

For an SDOF chain (cluster of 1), each `(scenario_idx, response_channel)`
calls `circle_fit.circle_fit_residue`:

```
(freqs, H, f_n, ζ) ──┐
                     ▼
   band = f_n · (1 ± 3·ζ)  ───►  if (#FFT bins in band) < MIN_FIT_BINS = 8
                     │                  return (residue=0+0j, fit_quality=0)
                     ▼
   algebraic circle fit (Kasa LS)
                     │
                     ▼  if var(|H|_band) < 1e-30:
                     │      fit_quality = 0
                     ▼
   |R| = 4 · radius · ζ · ω_n²
   phase = ∠(H_peak · 2j·ζ·ω_n²)
```

So an SDOF circle-fit produces `(0+0j, 0.0)` only when the fit band is too
narrow (the only zero-by-design path). The algebra always returns a
mathematically-valid `(centre, radius)` even on garbage input, so circle-fit
never silently NaNs from numerics — it returns a low-`fit_quality` instead.

For an MDOF cluster (2 to `MDOF_CLUSTER_CAP=4` chains), `rfp_fit.rfp_residue_fit`:

```
(freqs, H, mode_freqs_K, ζ_K) ──┐
                                ▼
   cluster band = [f_min - halo, f_max + halo]
   halo = 5 · max(ζ) · f_max
                                ▼  if n_bins < MIN_BINS_PER_MODE · K = 4·K:
                                │      return (residues=0,…,0)
                                ▼
   real-block complex LS: solve [Re(A) -Im(A); Im(A) Re(A)] [Re(x); Im(x)] = [Re(b); Im(b)]
                                ▼
   per-mode fit_quality from local-band SS_res / SS_tot
```

The RFP guard is more permissive (`4·K` bins vs SDOF's flat 8) but the same
fail-fast contract: too-narrow band → all-zero residues.

For `low_density_unresolved` chains (extras spilled out of an oversized
MDOF cluster), the orchestrator falls back to SDOF circle-fit per
`_extract_chain_residues` line 307-315 — so they hit the SDOF guard, not the
RFP one.

### Per-chain SVD inversion in `shape_inversion.py`

Inputs: a `(1, A, S)` complex tensor where `A` = `actuator_count = 180`
populated grid cells and `S = 7` response channels. The kernel:

```
for n in 0..M-1:                                # only 1 mode here
    row_finite = isfinite(R_n).all(axis=1)      # ← per-row: ALL S channels must be finite
    if not row_finite.any():                    # ← NO usable actuator rows
        continue                                #    → valid_mass[n] stays False
    Rn_usable = R_n[usable_rows]                # shape (A_u, S)
    U, σ, Vh = svd(Rn_usable)
    σ_0 = σ[0]
    u_0, v_0 = U[:, 0], Vh[0].conj()
    if σ_0 < 1e-30:    continue                 # ← NaN-edge guard
    M_a = max|u_0|;  M_v = max|v_0|
    if M_a < 1e-30 or M_v < 1e-30: continue     # ← NaN-edge guard
    m_n = 1 / (σ_0 · M_a · M_v)
    valid_mass[n] = True

if not valid_mass.any():
    raise RuntimeError("No mode produced a valid mass estimate")
```

The relevant NaN injection is the `row_finite.all(axis=1)` row-completeness
filter — a single NaN cell on a row drops the entire row.

### Orchestrator's zero→NaN mask (the multiplier)

In `modal_mass_orchestrator.py` line 596-597, **just before SVD**:

```python
zero_mask = (tensor[0] == 0)
tensor[0][zero_mask] = np.nan + 1j * np.nan
```

This rewrites the kernel's "I refused" sentinel `0+0j` as NaN. Combined with
`shape_inversion`'s row-completeness gate, **any actuator row where even
one of the seven channels failed circle-fit gets dropped entirely** —
even if six channels produced perfectly good residues. This is the dominant
mechanism turning bucket B/C into NaN at scale (see Phase 1 below).

The `try/except` at line 610 catches `RuntimeError` and writes `m_abs = NaN`,
which the JSON serialiser (line 703) maps to `null`.

### Reference-mode gate + cross-chain normalisation

Line 636-663: reference chain = lowest-`f` chain whose
`fit_quality_overall > 0.7` AND `coverage >= 0.5`. If none qualifies,
`reference_chain_id = None`, every chain's `m_relative = null` (line 705-707
require `m_ref is not None and m_ref > 0` to compute). LG_p3 found chain
312 (867 Hz, fit_quality 0.71, coverage 0.566) — fine, reference set.

### Decision tree summary

```
chain
  │
  ├─► every (sc, ch) circle/RFP fit returned 0+0j (band too narrow)
  │      → NaN  (bucket B: 242 chains; "kernel_refused_zero_residue")
  │
  ├─► some (sc, ch) cells succeeded, but no actuator row has ALL 7 channels finite
  │      → NaN  (bucket C: 126 chains; "no_full_row")
  │
  ├─► full-row scenarios exist, but only at unmapped indices (5000+, 180)
  │      → NaN  (bucket D: 3 chains; "unmapped_full_row")
  │
  └─► ≥1 mapped full-row scenario
         → SVD succeeds → m_absolute finite → m_relative = m_abs / m_ref
         → VALID  (386 chains)
```

---

## Live-disk audit results

### Top-line counts

```
Total chain_*.json files on disk:    757
Total summary chains in index.json:  757
Reference chain id:                  312 (867.5 Hz, fq=0.708, coverage=0.566)

Per-category counts:
  VALID:          386
  NAN_BY_DESIGN:  242 + 126 + 3 = 371

Structural checks:
  Duplicate chain_ids in summary:                 none
  Files on disk but not in summary:               none
  Summary entries but no file on disk:            none
  Summary vs payload field mismatches:            0 / 757 chains × 5 fields
  Reference chain m_relative == 1.0 exactly:      ✓
```

### NaN sub-classification by mechanism

```
NaN (every (sc,ch) residue = 0+0j; kernel refused all bands):    242
NaN (some residues nonzero, no mapped full-row scenario):        126
NaN (only-unmapped-full-row scenarios → orchestrator dropped):     3
─────────────────────────────────────────────────────────────────────
                                                          total   371
```

### Per `fit_method` × bucket breakdown

| fit_method | VALID | NaN: kernel-refused-all | NaN: no-full-row | NaN: only-unmapped | Total |
|---|---:|---:|---:|---:|---:|
| `sdof` | 0 | 30 | 0 | 0 | 30 |
| `mdof` | 48 | 83 | 0 | 0 | 131 |
| `low_density_unresolved` | 338 | 129 | 126 | 3 | 596 |
| **Total** | **386** | **242** | **126** | **3** | **757** |

Observations:

- **`sdof` is 100 % failed.** All 30 SDOF chains are at low-frequency
  isolated chains where `MIN_FIT_BINS = 8` blocks the band. (SDOF only fires
  when a chain has no MDOF neighbours; LG_p3 is dense enough that almost
  every chain finds a cluster neighbour.)
- **`mdof` is 37 % success.** 48 of 131 chains in a real cluster (2-4 close
  modes) get a mass. The RFP guard (`4·K` bins) is more permissive than
  SDOF's flat 8, but in low-frequency clusters even RFP loses.
- **`low_density_unresolved` is 57 % success.** These 596 chains landed in a
  cluster bigger than 4 and got fallback SDOF — yet most of them succeed,
  because they tend to be the higher-frequency chains with wide-enough bands
  for SDOF (`MIN_FIT_BINS` = 8 in a 1-Hz-bin FFT means a chain at `f_n=1000`
  with `ζ=0.005` needs `band = 1000 · 6 · 0.005 = 30 Hz` ≥ 8 bins
  trivially).

### Frequency distribution per bucket

```
VALID:                                n=386  min=27.4 Hz   med=1558 Hz   max=5981 Hz
NaN — kernel refused everywhere:      n=242  min=20.5 Hz   med=210  Hz   max=1114 Hz
NaN — no mapped full row:             n=126  min=1017 Hz   med=2013 Hz   max=5623 Hz
NaN — only-unmapped full row:         n=  3  min=1081 Hz   med=1353 Hz   max=2037 Hz
```

- Bucket B (kernel-refused) is **a low-frequency story**: 95th percentile at
  ~1100 Hz. Below ~150 Hz the FFT bin grid (1 Hz at 1 s window) cannot
  furnish 8 bins inside `±3·ζ·f` for typical `ζ ≈ 0.01` and `f ≈ 50` Hz
  (`band = ±1.5 Hz` ≈ 3 bins).
- Bucket C (no-full-row) is **a high-frequency story**: 1000-6000 Hz. At
  these frequencies every chain individually fits, but the SDOF/MDOF result
  per-channel is noisy enough that at least one of 7 channels returns
  `fit_quality = 0` in every scenario. The orchestrator's masking then
  drains the whole row.
- Bucket D (unmapped) is **inherently small**: 7 unique synthetic scenario
  indices (180, 5000, 5001, 5002, 5004, 5005, 5006) appear in chain
  payloads. Of all chains, only 3 had these as their sole full-row source.

### Reference chain consistency

```
ref chain 312:
  frequency_hz:           867.52
  coverage:               0.566   (passes ≥ 0.5 gate)
  fit_quality_overall:    0.708   (passes > 0.7 gate)
  fit_method:             mdof
  m_absolute:             9.176e-06
  m_relative:             1.0      ← required to be exactly 1.0 (✓)
  is_reference_mode:      True
```

### VALID-chain distribution diagnostics

```
fit_quality_overall   median = 0.130   mean = 0.176
                      > 0.5: 28 / 386     > 0.7: 22 / 386
m_relative            median = 0.032     min = 0.0011    max = 113.5
m_absolute            median = 2.9e-7    min = 1.0e-8    max = 1.0e-3
```

Note the median `fit_quality_overall` of 0.13 across VALID chains is **low**
in absolute terms — only 22 of 386 VALID chains (5.7 %) clear the 0.7
reference-mode gate. This is consistent with the Phase-2 IMPROVEMENT-PLAN
note that "the trustworthy chains (~40-50 of 126) have fit_quality ∈
[0.5, 0.9]" on the smaller PlyWoodLGtemp1 project. The frontend
opacity-ramp on `fit_quality_overall` is the existing UX control for
signalling this to the user.

### Cross-checks (passed)

- `index.json` summary fields (`m_absolute`, `m_relative`,
  `fit_quality_overall`, `fit_method`, `is_reference_mode`) match the
  per-chain `chain_<id>.json` payload exactly for all 757 chains.
- Every `chain_<id>.json` file referenced by `index.json` exists on disk;
  no orphan files.
- Per-chain `shape_actuator_mass_normalised` indices = `shape_actuator`
  indices (when both arrays present); same for response shapes. No
  raw-vs-mass-normalised mismatch.
- Mass-normalised entries equal `raw / sqrt(m_absolute)` to within 1 ULP
  (sampled).
- No duplicate `chain_id` in `index.json`.

The persisted modal-mass state is **internally consistent**.

---

## Per-category recommendations

### Bucket A — VALID (386 chains)

**No action.** Inversion succeeded; payload is consumable by the frontend.
The low `fit_quality_overall` median (0.13) is correctly surfaced via the
existing opacity-ramp UI introduced in `dev-mmui-6e97`. User can pick
trust-worthy chains visually.

### Bucket B — NaN, kernel refused all (242 chains)

**Confirm correct. Optional tuning available.**

**The behaviour is correct.** `MIN_FIT_BINS = 8` is the documented anti-
overfit gate: a circle-fit on < 8 points is unstable. The kernel returning
`(0+0j, fit_quality=0)` is the fail-fast contract. The orchestrator's
zero→NaN propagation is correct in turn.

**The low-frequency floor is well-defined:** a chain at frequency `f_n` Hz
with damping ratio `ζ` needs `band ≥ MIN_FIT_BINS · bin_width = 8 · 1 Hz =
8 Hz` (assuming the existing 1 Hz FFT bin width). With band ` = ±3·ζ·f_n`
this gives a fit-floor `f_n ≥ 8 / (6·ζ)`. For typical `ζ = 0.01`, the floor
is **133 Hz** — below which SDOF circle-fit is structurally impossible at
the current FFT resolution. Matches the observed bucket-B distribution
(median 210 Hz, max 1114 Hz; max indicates not all bucket-B chains are
purely floor-limited — some are higher-ζ MDOF outliers).

**Tuning lever — `MIN_FIT_BINS`.** Lowering from 8 to 5 would salvage
chains where the band falls in [5, 8) bins. Estimate of impact: cannot be
computed from the persisted data alone (the kernel didn't save the bin
count); requires Phase B re-run with instrumented circle_fit. Trade-off:
5-bin algebraic-LS circle fit is well-known to be biased (Maia & Silva
§6.2.2 recommends ≥ 8); lowering would degrade `fit_quality` across all
SDOF chains. **Recommendation:** keep `MIN_FIT_BINS = 8` until a controlled
synthetic-data study shows the bias is tolerable.

**Tuning lever — FFT bin width.** Increasing the FRF window from 1 s to 2 s
(0.5 Hz bins) doubles the bin density in any band, halving the
low-frequency floor to ~67 Hz. This is an upstream FRF-stage change, out
of modal-mass scope, but worth flagging as a follow-up to the
IMPROVEMENT-PLAN Phase 1.

**UX recommendation (S effort).** Surface bucket B as a distinct UX state.
The chain payload could carry an explicit `mass_inversion_status:
"insufficient_band_width"` field instead of just `m_absolute: null`. See
"Cross-cutting recommendation" below.

### Bucket C — NaN, no mapped full row (126 chains)

**Confirm correct under current contract. Algorithm tweak available.**

**The behaviour is correct under the dual-unit-max SVD contract.** The kernel
docstring specifies "every (a, s) finite in the row" — half-finite rows
would bias the rank-1 SVD because the missing channel's contribution to
the residue vector is unknown. The conservative choice is to drop the row.

**Why it bites bucket C so heavily:** the failure rate of a single channel
in a single scenario is non-trivial. With even a 10 % per-channel failure
rate, the probability of all 7 channels succeeding in one scenario is
`0.9^7 ≈ 0.48`, and across `n` scenarios the prob. of zero full rows is
`0.52^n`. For chains detected in only ~10 scenarios this is ~ 0.14 — a
sizeable fraction of high-frequency chains. The 126 bucket-C chains
correspond to ~21 % of all chains; numerically plausible.

**Algorithm tweak — partial-row SVD (M effort).** The kernel could fall back
to a partial-row SVD: when no full row exists, use the most-complete
rows (require at least 4 of 7 channels per row, say) and SVD the
column-subset. This recovers the dominant singular triplet from any rank-1
matrix as long as the SVD-able submatrix has rank 1, which a true rank-1
outer product always does (down to numerical noise from the missing cells).

This is **a worthwhile algorithmic exploration** but should land via a
separate `/analyse` session that:

1. Constructs synthetic rank-1 residue tensors with controlled missing
   cells.
2. Measures the bias of partial-row SVD vs the current full-row SVD.
3. Validates against the 126 bucket-C chains in LG_p3 (offline; reads the
   same `per_scenario_residues` JSON and re-runs the SVD with the relaxed
   gate).

Out of scope for this audit.

**Easier algorithmic tweak — relax row-completeness, fill missing cells
with mode-shape median (M effort).** Estimate the missing residue as the
median of the row's finite cells, run full-row SVD, record reduced
confidence. Cheaper than partial-row SVD but more sensitive to noise.
Also a follow-on `/analyse`.

### Bucket D — NaN, only unmapped full row (3 chains)

**Confirm correct, but flag the user surprise.**

**The behaviour is correct.** Synthetic scenarios (5000, 5001, 5002, 5004,
5005, 5006, plus 180 — observed in chain payloads) exist outside the
`point_coordinates` actuator grid for reasons that are upstream of
modal-mass (likely tare/calibration/silent measurements collected during
recording). The orchestrator's silent drop is the documented contract for
"scenario not in current grid mapping".

**The surprise is small (3 chains) but real.** For chains 370, 430, 542 the
ONLY scenario where every channel produced a nonzero residue is an
unmapped one. A user inspecting the chain payload sees nonzero per-scenario
residues and could reasonably expect a mass — but gets `null`.

**Recommendation (S effort).** Same as bucket B/C — a
`mass_inversion_status` field with value `"only_unmapped_full_row"`.
Alternatively, document the unmapped scenarios in the dropped-scenario
section of the chain payload (a `dropped_scenarios: [int]` list).

### Cross-cutting recommendation — `mass_inversion_status` field

**Severity:** Minor (UX clarity, not correctness).
**Effort:** S (~40 LOC backend, one chip in the frontend `ModalMassFreqChart`
tooltip).
**Owner:** new `/dev` agent.

The current chain payload makes the per-chain failure mode invisible: every
NaN looks like every other NaN. Adding a `mass_inversion_status` string:

| Value | Meaning | Bucket |
|---|---|---|
| `"valid"` | `m_absolute` finite | A |
| `"insufficient_band_width"` | every `(sc, ch)` returned 0+0j | B |
| `"no_full_row"` | nonzero residues exist, but no mapped row is all-finite | C |
| `"only_unmapped_full_row"` | full rows exist only in dropped scenarios | D |

The orchestrator already has all the information at line 596-619 (it knows
the tensor pre-mask, post-mask, and the catch outcome). Computing the
classification is a 10-line side-effect in the try-block. The frontend
tooltip lookup is a string-substitution.

**Why it's worth doing.** It transforms three opaque NaN classes into
debuggable user-facing signals. It also gives the orchestrator a stable
output contract for future tuning experiments (the partial-row-SVD or
relaxed-`MIN_FIT_BINS` follow-ups will all generate different per-chain
verdicts, and a typed `mass_inversion_status` is the contract for that).

---

## Concrete tuning proposals with expected impact

These are **not recommended for immediate adoption** — each requires a
controlled study before landing. They're tabulated here so the next
/analyse agent has the search space.

| # | Lever | Mechanism | Expected NaN salvaged | Confidence | Risk |
|---|---|---|---:|---|---|
| 1 | `MIN_FIT_BINS`: 8 → 5 | More bucket-B chains pass SDOF gate | 0-80 of 242 | Low — bin count not persisted | Biased circle-fit (Maia & Silva: ≥ 8 recommended) |
| 2 | FFT window: 1 s → 2 s (FRF stage) | Bin width 1 Hz → 0.5 Hz; doubles bins-per-band | 0-150 of 242 | Medium | FRF re-run; halves effective averaging count (lower coherence) |
| 3 | `MDOF_CLUSTER_CAP`: 4 → 6 | Fewer chains spill to `low_density_unresolved` (currently 596) | Some reshuffling, not net salvage | Medium | RFP conditioning degrades at higher K |
| 4 | Partial-row SVD (kernel rework) | Drop the all-7-channels gate; rank-1 SVD on any rank-1 submatrix | ~100 of 126 bucket-C | Medium — needs synthetic validation | Bias from non-uniform missing cells |
| 5 | Median-fill missing residue (kernel rework) | Estimate missing cell as median of finite cells in row | ~100 of 126 bucket-C | Low — heuristic | Sensitive to outlier residues |
| 6 | Include unmapped scenarios in actuator axis | Add synthetic actuator slot per unmapped scenario | 3 bucket-D chains | High | Pollutes mode-shape geometry (unmapped means no physical position) |

**The single change recommended for adoption** is the
`mass_inversion_status` field (cross-cutting). Everything else is
follow-up.

---

## Open questions for the user

1. **Are the synthetic scenarios (180, 5000-5006) expected to be present in
   the modal-mass payload?** If they're guaranteed not to carry usable
   actuator information (tare / silent / calibration), the orchestrator
   could drop them at FRF extraction time rather than silently in the SVD
   tensor build. This would also let the `mass_inversion_status` cleanly
   distinguish "unmapped" from "no data".
2. **Is the 5.7 % "trustworthy chain" rate (22 / 386 with
   `fit_quality_overall > 0.7`) acceptable for the LG_p3 workflow?** If
   not, the FFT window length is the most-impactful lever — but that's an
   FRF-stage decision, not a modal-mass one.
3. **Should `low_density_unresolved` chains continue to use SDOF circle-fit
   as their fallback?** With 596 of 757 chains in this bucket, an
   alternative (e.g. an even-larger-band MDOF fit with `K > cap`) might be
   worth exploring. Out of scope for this audit.

---

## Conclusion

The user's "371 NaN out of 757" is reproducible and exact. **No bug found
in the persisted output.** Every NaN traces to an architecturally correct
refusal at one of three gates:

1. The kernel-side `MIN_FIT_BINS = 8` (and the RFP `4·K`) anti-overfit gate
   — 242 chains.
2. The kernel-side row-completeness gate in `shape_inversion.py` — 126
   chains.
3. The orchestrator-side actuator-mapping filter for synthetic scenarios —
   3 chains.

The reference chain (312, 867 Hz) is correctly identified and has
`m_relative = 1.0` exactly. Index ↔ per-chain payload consistency is
perfect across 757 chains. The mass-normalised shapes are mathematically
consistent with their raw counterparts.

**Recommendation to the orchestrator:** ship the `mass_inversion_status`
field via a small `/dev` task (S effort). Defer all other tuning to
follow-up `/analyse` sessions with controlled before/after studies. No
immediate /dev bug-fix is needed.

---

## Artefacts

- Audit script:
  `docs/development/diagnostics/ana-mmnan-7c3a-audit.py`
- Invalid-chain JSON dump:
  `docs/development/diagnostics/ana-mmnan-7c3a-invalid-chains.json`
  (records the 129 chains my initial heuristic classified as INVALID;
  re-analysis above places them all into NaN buckets C and D — no real
  bugs)

## References

- `docs/proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md` —
  §5.2.1 + §5.2.3 (residue extraction theory + design); Phase 2 line
  881-890 (the original Phase-2 verification heads-up about low-`f` SDOF
  chains).
- `PianoidCore/pianoid_middleware/modal_adapter/modal_mass/circle_fit.py`
  lines 64, 121-138 (the `MIN_FIT_BINS = 8` gate).
- `PianoidCore/pianoid_middleware/modal_adapter/modal_mass/rfp_fit.py`
  lines 53, 109-115 (the `MIN_BINS_PER_MODE · K` gate).
- `PianoidCore/pianoid_middleware/modal_adapter/modal_mass/shape_inversion.py`
  lines 158-185 (the row-completeness gate + `σ_0 < 1e-30` + `M_a/M_v <
  1e-30` numeric edges).
- `PianoidCore/pianoid_middleware/modal_adapter/modal_mass_orchestrator.py`
  lines 581-584 (actuator-mapping filter), lines 596-597 (zero→NaN mask),
  lines 599-619 (inversion try/except), lines 703-707 (NaN → JSON null
  serialisation), lines 636-663 (reference-mode gate).
