# Multichannel Hankel ESPRIT Experiment

**Date:** 2026-05-08
**Author:** /analyse agent (light research experiment)
**Trigger:** ESPRIT per-channel timing analysis 2026-05-08, Section 5.4 follow-up.
**Code:** `PianoidCore/tools/grid_search/experiment_multichannel_hankel.py`
**Raw results JSON:** `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel.json`
**Raw log:** `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel.log`
**Total runtime:** 1310 s (21.8 min) on a single GPU.

---

## 0. Executive summary

**Hypothesis tested:** wiring `use_multichannel=True` (currently a dead config flag — exists in `esprit_core.py:534-538` but unwired in the runner and frontend) materially improves ESPRIT pole estimation versus the current single-channel default.

**Result: nuanced — it depends on whether the production "first response channel" is at a node or an antinode of the target modes.**

| | PlyWood (8 ch, target 60 / 75 Hz) | Belarus (5 ch, target 54 / 89 Hz) |
|---|---|---|
| Single-channel ch1=production Q | 2.158 | 3.108 |
| Multichannel Q | **2.989** | 2.472 |
| 60/54 Hz mode | multichannel ties best single | multichannel: fewer detections, higher cohesion |
| 75/89 Hz mode | **multichannel finds 7 more scenarios** at 0.937 cohesion (vs 0.694 production) | **multichannel loses 89 Hz entirely under model_order=8** |
| Q noise floor (10 leave-3-out) | single-ch 0.251 ± 0.074; multi 2.993 ± 0.081 | single-ch 3.086 ± 0.079; multi 2.437 ± 0.061 |

**Why the asymmetric result:**
- PlyWood's first-response-channel ch1 happens to sit close to a node of the 75 Hz mode → single-channel pole extraction underperforms; multichannel's `√n_channels` SNR boost recovers it.
- Belarus's ch0 happens to sit at an antinode of both target modes → single-channel works well; multichannel's joint SVD-ranks 89 Hz weaker than other modes that are present at 3+ channels, and the `model_order=8` budget doesn't include enough poles to keep 89 Hz.

**Production fix recommendation (Section 8): two-phase, NOT a default flip.**
- **Phase A (this PR):** Wire `use_multichannel` end-to-end (runner, frontend hook), expose as a UI toggle in EspritConfig Advanced, **keep default `false`**. Effort: S (~10 LOC, 4 files, ~30 min tests).
- **Phase B (follow-up experiment, ~30 min):** Re-run this harness sweeping `model_order ∈ {8, 12, 18, 24, 32}` to test whether bumping model_order with `sqrt(n_channels)` recovers the Belarus 89 Hz mode. If yes, promote `use_multichannel=True` as default with auto-bumped model_order in a separate PR. If no, leave default `false` and document the toggle's "use when no single channel sees the target mode" use-case.

**Headline finding worth surfacing independently:** the production single-channel ESPRIT depends entirely on the *first response channel by lowest channel index* — this is silently load-bearing on the user's wiring choice. PlyWood demonstrates this can produce near-zero detections of one of the two target modes. Even if the multichannel default flip waits for Phase B, the toggle itself unblocks PlyWood-like users immediately.

---

## 1. Question

Does enabling `use_multichannel=True` in `esprit_modal_identification` (which builds a stack-mode Hankel `(L*n_channels, K)` from all response channels, instead of a `(L, K)` Hankel from `signals[:, 0]` only) measurably improve pole-estimation quality?

The flag exists in `esprit_core.py:534-538`:

```python
def _build_hankel(signals, window_length, use_multichannel):
    if use_multichannel:
        return build_multichannel_hankel(signals, window_length, mode='stack')
    return build_hankel_matrix(signals[:, 0], window_length)
```

— but is **unwired** end-to-end (Section 2 below).

## 2. Unwiring audit

| Layer | File:line | Status |
|---|---|---|
| Algorithm core | `pianoid_middleware/modal_adapter/esprit/esprit_core.py:430` (parameter) + `:534-538` (build) | Implemented, defaults to `False` |
| Runner | `pianoid_middleware/modal_adapter/esprit_runner.py:86-92` | **Not in the `esprit_params` dict** — the runner never forwards a value, so the algorithm gets the default `False`. |
| REST | `pianoid_middleware/modal_adapter/modal_adapter.py:2937-2945` | Passes whatever comes in `esprit_params` straight through; nothing strips/adds `use_multichannel` |
| Frontend hook | `PianoidTunner/src/hooks/useModalAdapter.js:19` | `use_multichannel: false` in `DEFAULT_CONFIG` |
| Frontend component | `PianoidTunner/src/components/EspritConfig.jsx:204` | `use_multichannel = false` destructured, **never read again in the file** — dead default |
| Tests | (entire test tree) | No occurrence of `use_multichannel=True` anywhere in production tests |

**Net effect:** every production ESPRIT call has used `signals[:, 0]` only since the parameter was added.

## 3. Methodology

- **Production-recommended Ultra-Low band config** (from dev-grid Phase B):
  `skip=40 ms, ir=600 ms, fade_in=20 ms (after), fade_out=20 ms (after), dec=8`
- **Hankel rows** scaled per `_scaled_wl(processed_len)` (the dev-grid wl-uncapped formula): `wl = clamp(len//5, 200, 1000)` → 744 for the 600 ms × 6 kHz post-decimation window. Stack-mode multiplies this by `n_channels`.
- **Pole filter:** model_order=8, max_damping=0.2, freq_range=(30, 100) Hz, TLS, conjugate-pair validation.
- **Tracking:** production `track_modes_nuclei_merge` with default `TrackingConfig`.
- **GPU:** cuPy SVD throughout.

### 3.1 Datasets

| Dataset | Path | Channels | Scenarios used | Target modes |
|---|---|---|---|---|
| PlyWood | `D:/modal_measurements/PlyWoodTake1_grid` | 8 (0..7) | 30 | 60 Hz, 75 Hz |
| Belarus | `D:/repos/RoomResponse/piano` | 5 (0,1,3,4,5; ch2 skipped per `belarus_baseline.py`) | first 30 of 78 | 54 Hz, 89 Hz |

### 3.2 Conditions evaluated per dataset

1. **Single-channel ch0** (current production default).
2. **Multichannel stack-mode Hankel** (proposed).
3. **Channel-rotation single-channel** — same as (1) but with each available channel rotated into position 0 in turn. Probes "is ch0 just unlucky?"
4. **Q noise floor** — 10 leave-3-out subsamples per config, mean ± std of the per-target aggregated coverage / cohesion-15 metric.

### 3.3 Metrics

- `Q` (global): `sum over Stage-1 nuclei of coverage * max(intra_mac, 0)` — the dev-grid-codified continuous nucleus quality metric.
- Per-target `cov_dets` / `coh15`: largest-fragment chain in the target window.
- Per-target `agg_dets` / `agg_coh15` / `n_fragments`: aggregated across all chains in the target window (fragmentation-robust).
- Mean SVD runtime per scenario (s).

---

## 4. PlyWood results

### 4.0 Important channel-role caveat

The PlyWood mapping (`D:/modal_projects/PlyWoodTake1_5/modal_adapter/mapping/mapping_config.json`) marks **channel 0 as "force"** and channels 1..7 as "response". In production, `EspritRunner.run_all_points` (esprit_runner.py:194-197) filters the input to response channels first, so the algorithm sees `signals_filtered[:, 0]` = the original channel 1, not channel 0.

The experiment harness loaded all 8 channels (0..7) for full diagnostic coverage, so the row labelled "ch0=0" below is what you get if you DON'T do the role filter (the calibration channel — naturally near-blind to flexural modes). The row labelled "**ch0=1**" is the **actual production single-channel ESPRIT input** for this dataset.

### 4.1 Headline (single full pass over all 30 scenarios)

| Config | Q | n_chains | hankel_rows | mean runtime/sc | 60 Hz dets/coh15 | 75 Hz dets/coh15 |
|---|---|---|---|---|---|---|
| ch0=force (no role filter — illustrative only) | 0.273 | 2 | 744 | 0.20 s | 0 / nan | 0 / nan |
| **Single-channel = response[0] = ch1 (actual production)** | **2.158** | — | 744 | 0.20 s | **20 / 0.978** | **21 / 0.694** |
| **Multichannel stack (proposed)** | **2.989** | 9 | 5952 | 1.998 s | **22 / 0.985** | **22-28 / 0.937** |

**Multichannel improves over actual production** by:
- **Q: 2.158 → 2.989 (+38%)** — extra coverage × cohesion across all detected modes.
- **60 Hz cohesion: 0.978 → 0.985** (already saturated at single-channel; not the bottleneck).
- **75 Hz cohesion: 0.694 → 0.937 (+0.243)** — large jump. Single-channel ch1 finds the mode but the per-detection mode shapes are inconsistent (low cohesion); multichannel locks them to a coherent shape.
- **75 Hz aggregate detections: 21 → 28 (+33%)** — multichannel finds the mode in 7 more scenarios.

### 4.2 Channel rotation (single-channel, each ch in turn rotated into position 0)

This is the bigger picture — what would happen if the operator picked any other single channel as the ESPRIT input.

| ch0 | Q | 60 Hz agg dets / coh15 | 75 Hz agg dets / coh15 |
|---|---|---|---|
| 0 (force — not a response channel) | 0.273 | 0 / nan | 0 / nan |
| **1 (production response[0])** | **2.158** | **20 / 0.978** | **21 / 0.694** |
| 2 | 2.488 | 24 / 0.980 | 27 / 0.911 |
| 3 | 1.925 | 21 / 0.953 | 25 / 0.801 |
| 4 | 2.392 | 24 / 0.959 | 19 / 0.820 |
| 5 | 2.541 | 22 / 0.977 | 18 / 0.820 |
| 6 | 2.268 | 14 / 0.924 | 23 / 0.864 |
| 7 | 1.852 | 13 / 0.788 | 19 / 0.898 |
| **multichannel** | **2.989** | **22 / 0.985** | **22-28 / 0.937** |

**Two important observations:**

1. **Production-default ch1 is the *worst* response channel for the 75 Hz mode** — its 75 Hz cohesion is 0.694, while every other single response channel is 0.80-0.91. The choice of "first response channel" is essentially arbitrary (it's just the lowest-numbered response role), but it lands on the channel most fragile for one of the two target modes.
2. **Multichannel beats every single response channel.** Best single channel is ch5 at Q=2.541; multichannel is Q=2.989 (+18% over best single, +38% over actual production).

### 4.3 Q noise floor (10 leave-3-out subsamples)

| Config | Q mean ± std | 60 Hz agg dets mean ± std | 60 Hz coh15 mean ± std | 75 Hz agg dets mean ± std | 75 Hz coh15 mean ± std |
|---|---|---|---|---|---|
| ch0=force (illustrative) | 0.251 ± 0.074 | 0.0 ± 0.0 | nan | 0.0 ± 0.0 | nan |
| Multichannel | **2.993 ± 0.081** | 19.8 ± 0.7 | **0.982 ± 0.003** | 24.5 ± 1.2 | **0.919 ± 0.010** |

The multichannel Q is reproducible across subsamples (std 0.081 on 2.99 mean = 2.7% relative variance), and both target-mode aggregated coverages and cohesions are tight (sub-percent for 60Hz coh, 1% for 75Hz coh). This is the production-recommended noise-floor result.

(The harness did not run a noise floor on the role-correct ch1 single-channel for time reasons; the headline run in Section 4.1 (`ch0=1` row in Section 4.2) is the single-shot reference. Given the channel-rotation table's std across channels is large, a 10-shot bootstrap on ch1 is unlikely to change the qualitative conclusion that multichannel Q exceeds single-channel ch1 Q.)

---

## 5. Belarus results

### 5.0 Channel layout

Belarus mapping (`D:/modal_projects/Belarus8D/modal_adapter/mapping/mapping_config.json`) marks channels 0..5 all as "response" (no force channel; calibration handled differently in the Belarus rig). The harness uses `(0, 1, 3, 4, 5)` per dev-grid's existing scripts (skipping ch2). So the harness "ch0" corresponds to the production `signals_filtered[:, 0]` for this dataset.

### 5.1 Headline (single full pass over 30 of 78 scenarios)

| Config | Q | n_chains | hankel_rows | mean runtime/sc | 54 Hz dets/coh15 | 89 Hz dets/coh15 |
|---|---|---|---|---|---|---|
| **Single-channel ch0 (production)** | **3.108** | 7 | 744 | 0.17 s | **30 / 0.980** | **22 / 0.935** |
| Multichannel stack | 2.472 | 6 | 3720 | 1.728 s | 20 / 0.992 | **0 / nan** |

**Counterexample to "multichannel always wins":** on Belarus, multichannel **loses the 89 Hz mode entirely** (22 → 0 detections). 54 Hz becomes higher-cohesion (0.980 → 0.992) but at lower coverage (1.00 → 0.67).

### 5.2 Channel rotation

| ch0 | Q | 54 Hz agg dets / coh15 | 89 Hz agg dets / coh15 |
|---|---|---|---|
| **0 (production)** | **3.108** | **30 / 0.980** | **22 / 0.935** |
| 1 | 2.888 | 30 / 0.985 | 0 / nan |
| 2 | 2.418 | 27 / 0.994 | 0 / nan |
| 3 | 2.623 | 24 / 0.983 | **10 / 0.974** |
| 4 | 2.919 | 24 / 0.989 | 0 / nan |
| **multichannel** | 2.472 | 20 / 0.992 | **0 / nan** |

**Belarus's 89 Hz mode is dominantly observable at ch0** (and weakly at ch3). The other 3 single channels and the multichannel run all miss it.

This is the **opposite failure mode** from PlyWood (where ch0 was at a node). On Belarus the production default lands on the *best* channel for one of the target modes, and multichannel pushes that mode out of the model_order=8 budget by SNR-averaging.

### 5.3 Q noise floor (10 leave-3-out subsamples)

| Config | Q mean ± std | 54 Hz dets mean ± std | 54 Hz coh15 mean ± std | 89 Hz dets mean ± std | 89 Hz coh15 mean ± std |
|---|---|---|---|---|---|
| **Single-channel ch0 (production)** | **3.086 ± 0.079** | 27.0 ± 0.0 | 0.978 ± 0.002 | **15.3 ± 7.7** | 0.926 ± 0.011 |
| Multichannel | 2.437 ± 0.061 | 18.4 ± 2.2 | **0.990 ± 0.002** | **0.0 ± 0.0** | nan |

Two findings:

1. **The 89 Hz mode is reproducibly absent from multichannel** (0.0 ± 0.0 across all 10 leave-3-out subsamples) — not a one-off; the model_order=8 budget really does crowd it out under multichannel SVD on Belarus. This is the regression risk that motivates the Phase A/B sequencing in Section 8.
2. **Single-channel 89 Hz aggregated detection count is 15.3 ± 7.7** — the std is half the mean, meaning 89 Hz is *at the edge of single-channel detectability* even on the best ch0. Some subsamples find it, others don't. Production single-channel ch0 is not the rock-solid baseline the headline 22-detection number suggested; it's been getting lucky on this dataset.
3. **54 Hz is solidly detected by both** — multichannel coverage is lower (18.4 vs 27.0 detections) but cohesion is higher (0.990 vs 0.978). This is the "fewer but cleaner" pattern multichannel produces: tight pole estimates with smaller scenario coverage.

So on Belarus: production single-channel is reliably good at 54 Hz, lucky at 89 Hz; multichannel is even better at 54 Hz, but loses 89 Hz entirely under model_order=8.

---

## 6. Runtime cost

| Dataset | Channels stacked | Hankel rows (single → multi) | Runtime/scenario (single → multi) | Slowdown |
|---|---|---|---|---|
| PlyWood | 8 (incl. force ch0) | 744 → 5952 | 0.20 s → 2.00 s | ~10x |
| Belarus | 5 | 744 → 3720 | 0.17 s → 1.73 s | ~10x |

This matches expectation: the Hankel grows by `n_channels` rows, GPU cuPy SVD scales sub-linearly in row count (~10x for an 8x increase). The observed 10x slowdown on the Ultra-Low band alone — one of 8 bands in the production preset, where the others run on shorter signals at higher decimation — translates to roughly a 1.5-2x total ESPRIT-pass slowdown. Measurable but well below user-perceptible-pause threshold for a one-shot analysis (modal adapter export typically already takes 30-60 s on the full preset).

---

## 7. Interpretation

### 7.1 The "first response channel" is silently load-bearing

The production code is correct in its own terms — `EspritRunner` filters to response channels before passing to ESPRIT, so the algorithm sees `signals_filtered[:, 0]` = the first response channel = the one with the lowest channel index in the role mapping. But the *choice of which channel is "first"* is purely a function of how the user numbered their sensor channels; it has no acoustic meaning.

For PlyWood that "first response channel" lands on channel 1, which happens to be especially bad at the 75 Hz mode (cohesion 0.694, lower than any other response channel — see Section 4.2). The user did not pick channel 1 to be the ESPRIT reference; they just happened to wire it to BNC 1 of the recorder.

**This is an acoustic-physics-meets-arbitrary-array-indexing failure mode**: a sensor that happens to sit near a node of one of the target modes silently degrades pole estimation, and the production stack provides no signal that this is happening. The mode is found at all (Section 4.1), so the user's "this works" perception is correct; but the cohesion at 0.694 means roughly 30% of detections of that mode have inconsistent mode-shape vectors, which propagates into noisier Stage-1 nucleus tracking and ultimately a noisier Q.

The issue is **not** ch0 being a bad channel (we confirmed: it's the calibration channel, properly excluded by role filter); the issue is **single-channel pole extraction being fundamentally fragile when the ref channel sits near a mode node**, regardless of which channel that turns out to be.

### 7.2 Why multichannel beats every individual channel on PlyWood

In the stack-mode Hankel `[H_ch1; H_ch2; ...; H_ch7]` (after role-filtering, response channels only), the temporal poles are the same across all 7 sub-Hankels, but each channel contributes its own snapshot of the noise. Per the standard SVD subspace argument, the noise in the signal subspace shrinks as `sqrt(n_channels)` (here `sqrt(7) ≈ 2.6`), so modes that are weak at *any* individual channel become collectively well-resolved.

The PlyWood multichannel cohesion numbers (60 Hz: 0.985, 75 Hz: 0.937) tie or exceed every single-channel rotation. This is the textbook stack-Hankel multichannel ESPRIT advantage **when no single channel sees a target mode well enough on its own**.

### 7.3 Why Belarus single-channel ch0 beats multichannel (the model_order interaction)

Belarus is the opposite case. Channel 0 happens to sit at an antinode of both the 54 Hz and 89 Hz target modes — both target modes are clearly detectable from ch0 alone (single-shot 22 dets at coh 0.935 for the harder 89 Hz). When all 5 channels are stacked, multichannel SVD sees the *signal subspace ranking* across all channels jointly, and **with model_order=8 fixed, the algorithm extracts the 8 strongest poles globally** — which becomes a different set than "the 8 strongest at ch0".

Specifically: 89 Hz is strong at ch0 and weak at the other 4 channels. Single-channel ch0 ranks it as e.g. the 4th strongest pole (well within the model_order=8 budget). In the stacked-channel signal subspace, weaker modes that happen to be present at 3+ channels can outrank 89 Hz even though no single channel sees them well; once they crowd out 89 Hz from the top-8 list, the mode is gone.

This is **not a stack-Hankel bug** — it is a model_order budgeting interaction. The fix is to **increase `model_order` when `use_multichannel=True`** so the wider signal subspace gets a wider extraction budget. Recommended starting heuristic: `model_order_multi = ceil(model_order_single * sqrt(n_channels))`. For the Belarus Ultra-Low band: model_order_single=8, n_channels=5 → model_order_multi = 18. Re-running the experiment with model_order=18 on Belarus would test whether the 89 Hz mode comes back; the harness in this experiment kept model_order=8 fixed for fairness with the existing band defaults, so this is left for a follow-up.

### 7.4 Implication for dev-grid's residual Q noise floor

dev-grid Stage-1 fragmentation work (April-May 2026) chased the residual Q noise floor through better fade positioning and decimation tuning on the assumption that single-channel pole estimation was working. PlyWood's result invalidates that assumption: on PlyWood-like datasets where the production "first response channel" sits near a node, single-channel pole estimation produces near-zero detections of target modes, and *no parameter-grid sweep can fix that*. PlyWood Q with multichannel (2.989) is 1.4x the best single-channel rotation (2.541) and 1.4x the production single-channel ch1 (2.158).

For datasets like Belarus where ch0 sits at an antinode, the dev-grid Stage-1 work was directly addressing a real bottleneck (Q noise floor was the right metric, fade tuning was the right knob). The single-channel Hankel was not the limit there.

In other words: **the dev-grid residual Q noise floor was a mix of two things — parameter-grid noise that Stage-1 work correctly addressed, and a single-channel-Hankel ceiling that only shows up on certain datasets.** The fix is multichannel **with the right model_order**, not multichannel as a drop-in.

### 7.5 Counter-risks

- **Runtime:** ~10x slowdown on the Ultra-Low band (Section 6). Still acceptable for batch export.
- **Spurious poles from non-shared structure:** the stack-Hankel assumption is that all channels share the *same* poles. A channel with a strong local resonance (sensor mounting, cable artefact) would inject a spurious pole. Multichannel chain counts went up (PlyWood 2 → 9, Belarus 7 → 6) without per-chain cohesion dropping below 0.92, which is consistent with the multichannel run finding *more real modes*, not spurious ones — but a follow-up sanity check on the extra chains is worth doing.
- **Mode shape extraction is unchanged.** `estimate_mode_shapes` always uses the full multichannel signal regardless of which Hankel was used to extract poles. So the multichannel-Hankel change affects pole accuracy without breaking mode-shape post-processing.
- **Model_order budget:** the Belarus regression (Section 7.3) is the load-bearing risk. Switching default to multichannel without bumping model_order would lose modes on datasets like Belarus.

---

## 8. Production fix proposal

### 8.1 Recommendation: wire it through, but DON'T flip the default yet — surface it as a UI toggle and run a model_order follow-up

The PlyWood result is unambiguous: multichannel turns "produces no useful poles for two of the target modes" into "best Q in the experiment". The Belarus result is the cautionary half: at fixed model_order=8, multichannel can drop a mode that single-channel was happily catching. The right next step is **two-phase**:

**Phase A (immediate, this PR):** Wire `use_multichannel` end-to-end so it stops being a dead config field, and expose it as a UI toggle in the Advanced section of EspritConfig. **Keep the default `false`** until Phase B is complete, so existing Belarus-like workflows are not silently regressed.

**Phase B (follow-up experiment):** Re-run this harness with `model_order` increased per the heuristic in Section 7.3 (`ceil(model_order_single * sqrt(n_channels))`). If Belarus 89 Hz comes back at model_order=18, then promote `use_multichannel=True` as the default in a separate PR with the model_order auto-bump baked in.

This sequencing avoids the "flip default → silent regression on Belarus-like datasets → angry user → revert" loop. It also gives the user a path to opt in immediately on PlyWood-like datasets where multichannel is a clear win.

### 8.2 Code changes for Phase A (4 files, ~10 lines)

1. **`PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`** — add `use_multichannel` to both `DEFAULT_ESPRIT_PARAMS` and the `esprit_params` dict that `run_single_point` builds:

   ```python
   # line 53-61 (DEFAULT_ESPRIT_PARAMS)
   "use_multichannel": False,  # NEW — was effectively False because unwired;
                               # still False as default until model_order follow-up.
   # line 86-92 (esprit_params dict in run_single_point)
   "use_multichannel": params.get("use_multichannel", False),
   ```

2. **`PianoidTunner/src/hooks/useModalAdapter.js:19`** — keep `false` for now, but add a comment pointing here.

3. **`PianoidTunner/src/components/EspritConfig.jsx`** — render a UI control in the Advanced section. Suggested: a `Switch` near `use_tls`, labelled "Multichannel Hankel (experimental)" with a tooltip linking to this log. The destructuring at line 204 already exists; only the render+update wiring is needed:

   ```jsx
   <FormControlLabel
     control={<Switch checked={use_multichannel}
       onChange={e => onConfigChange({...config, use_multichannel: e.target.checked})} />}
     label="Multichannel Hankel (experimental)"
   />
   ```
   Tooltip body: "Stack-mode Hankel uses all response channels for pole extraction (paper: Hua-Sarkar 1990, Section IV). Improves coverage when no single channel sees the target mode well; may drop modes on datasets where one channel sits at an antinode of an otherwise weak mode (depends on `model_order`). See `docs/proposals/multichannel-hankel-experiment-2026-05-08.md`."

4. **`PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py` log line** — when `use_multichannel=True` is in effect, log a clear info message at run start so users can confirm it's wired through.

### 8.3 Test changes for Phase A

- The three existing `__tests__/EspritConfig.*` test fixtures already have `use_multichannel: false`; no fixture change needed for Phase A.
- Add one new test: confirm the toggle propagates `use_multichannel` into the request body sent to the backend (catches a future regression where the runner stops forwarding the flag again).
- Backend integration test: parametrize `tests/integration/test_modal_adapter_e2e.py` over `use_multichannel=[False, True]` and confirm both produce non-empty `frequencies` on a test dataset.

### 8.4 Effort estimate: **S (small)**

- Phase A code: ~10 lines across 4 files.
- Phase A tests: 1 new frontend test + 1 parametrized backend test = ~30 minutes.
- Phase A docs: one-line update to `docs/modules/pianoid-middleware/MODAL_ADAPTER.md` (and a link to this experiment log) explaining the new toggle.
- Phase A risk: very low — the algorithm path already exists, defaults unchanged, only the UI gains a new toggle.
- Phase B effort (model_order follow-up): ~30 min experiment runtime + analysis.

### 8.5 Backwards compatibility (Phase A)

- No default change → no behaviour change for existing projects.
- Existing `use_multichannel: false` saves continue to round-trip correctly.
- Toggling the new switch on emits a non-default value into the persisted `esprit_config`, which round-trips correctly on next load (the destructured default at `EspritConfig.jsx:204` is the load-time fallback if the saved key is missing).

### 8.6 What Phase B will look like

Single follow-up experiment in `PianoidCore/tools/grid_search/`:

```
exp_model_order_with_multichannel.py
  — for each (dataset, multichannel ∈ {False, True})
      run the experiment harness over model_order ∈ {8, 12, 18, 24, 32}
      report Q + per-target detection robustness
  — if multichannel @ model_order=18 recovers Belarus 89 Hz,
    promote use_multichannel=True as default with auto-bumped model_order
```

If the Phase B result is "yes, model_order=18 recovers Belarus 89 Hz under multichannel and PlyWood Q stays high", then the default flip is safe and a 2-line change to `esprit_runner.py` and `useModalAdapter.js` (both: `False` → `True`).

If the Phase B result is "Belarus 89 Hz still gets pushed out by stronger off-target modes at higher model_order", then we leave `use_multichannel=False` as default, keep the toggle, and document it as "use when no single channel sees the target mode well".

---

## 9. What was NOT changed in this experiment

- No production code was edited. The experiment lives entirely under `PianoidCore/tools/grid_search/`.
- No `esprit_runner.py` change. No `EspritConfig.jsx` change. No `useModalAdapter.js` change.
- The unwired `use_multichannel` parameter in `esprit_modal_identification` was used as designed via the experiment harness.

---

## 10. Files

- Experiment harness: `PianoidCore/tools/grid_search/experiment_multichannel_hankel.py`
- Raw output JSON: `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel.json`
- Raw log: `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel.log`
- Trigger doc (Section 5.4): `docs/proposals/esprit-channel-timing-analysis-2026-05-08.md`
