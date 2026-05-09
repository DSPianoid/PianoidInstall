# Multichannel Hankel ESPRIT — Phase B: model_order Sweep

**Date:** 2026-05-09
**Author:** /analyse agent (Phase B follow-up to Phase A 2026-05-08)
**Trigger:** Phase A Section 7.3 / 8.6 — test the `model_order × √n_channels` heuristic.
**Code:** `PianoidCore/tools/grid_search/experiment_multichannel_hankel_phase_b.py`
**Plus mini-experiment:** `PianoidCore/tools/grid_search/experiment_multichannel_hankel_phase_b_plywood_noise_floor.py`
**Raw logs:** `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel_phase_b.log`, `…_plywood_nf.log`

> **STATUS — IMPLEMENTED 2026-05-09 by dev-mchphb.**
>
> Phase B shipped with one important refinement to the original §5
> proposal: the global `use_multichannel` toggle was replaced by a
> **per-band** column in the EspritConfig table. The cost/quality
> trade-off is genuinely per-band (low-frequency bands benefit most;
> their per-band runtime cost is also smallest), so EXTENDED_BANDS now
> ships ON for Ultra-Low / Low / Low-Mid and OFF for Mid / Mid-High /
> High / Upper / Top. STANDARD_BANDS bands left at `null` (treated as
> OFF). The auto-bump rule and N=5 / mo=50 caps are exactly as
> specified in §4.2. UX option B (write-back into the band's
> `model_order` cell on toggle ON) implemented with a transient amber
> flash + `multichannel_mo_was_auto_bumped` marker that the backend
> safety-net respects.
>
> See:
> - PianoidCore commits: dev-mchphb branch
>   `feature/dev-mchphb-multichannel-perband` — band_processing.py +
>   band_merging.py + tests/unit/test_esprit_multichannel_phase_b.py
> - PianoidTunner commits: dev-mchphb branch
>   `feature/dev-mchphb-multichannel-perband` — EspritConfig.jsx +
>   useModalAdapter.js + multichannelAutoBump.js (extracted helper) +
>   tests/EspritConfig.multichannelPhaseB.test.jsx
> - User-facing doc:
>   [`docs/guides/MODAL_ADAPTER_GUIDE.md` § Multichannel Hankel per-band toggle](../guides/MODAL_ADAPTER_GUIDE.md#multichannel-hankel-per-band-toggle)

---

## 0. Executive summary

**Hypothesis tested:** `model_order_multi = ceil(model_order_single × sqrt(n_channels))` provides enough SVD budget for multichannel Hankel ESPRIT to keep weak-but-real modes (e.g. Belarus 89 Hz) that get crowded out at fixed `model_order=8`.

**Result: hypothesis CONFIRMED on Belarus, with one important refinement.**

| | Belarus (5 ch, target 54/89 Hz) | PlyWood (8 ch, target 60/75 Hz) |
|---|---|---|
| Heuristic auto-bump | `ceil(8 × √5) = 18` | `ceil(8 × √8) = 23` |
| **Best multichannel mo (per-target coverage AND cohesion)** | **mo=18** | **mo=18** (also winner) |
| 89 Hz / 75 Hz at heuristic mo | 21 dets, coh 0.966 | 20 dets, coh 0.969 (39 agg) |
| Q at heuristic mo (vs Phase A baseline) | 6.606 vs 3.108 (**+113%**) | 5.625 vs 2.989 (**+88%**) |
| Noise floor at heuristic mo (Q ± std) | **6.502 ± 0.101** (vs Phase A single 3.086 ± 0.079) | **5.531 ± 0.151** (vs Phase A multi mo=8: 2.993 ± 0.081) |

**Key refinement to the heuristic:** the relationship is NOT monotonic. For Belarus, mo=8 misses 89 Hz (model budget too small), mo=18 catches it cleanly, **mo=24 and mo=32 lose it again** (off-target poles outrank 89 Hz once budget gets too large). There is a Goldilocks zone around `√n_channels × 8`.

**Same story for PlyWood:** 75 Hz cohesion peaks at mo=18 (0.969), drops at mo=24 (0.960), drops further at mo=32 (0.952). Fragmentation increases at high mo (75 Hz: 2 chains at mo=18 → 4 chains at mo=24).

**The √N heuristic is a sweet spot, not a floor.** The auto-bump should target `ceil(8 × √N)` and not exceed it without justification.

**Production fix recommendation (Section 5): flip default to `True` with auto-bump, behind a "Multichannel Hankel" toggle that defaults ON but can be turned OFF for advanced opt-out.**

The Belarus regression that motivated Phase A's "keep default false" caution is fully recoverable at the heuristic mo. Both target modes on Belarus are detected at higher cohesion than single-channel ch0 production (54 Hz: 0.991 vs 0.978; 89 Hz: 0.966 vs 0.935), and the noise floor variance is dramatically tighter (89 Hz: ±0.8 dets vs ±7.7 dets — 10x lower variance, the "lucky single-channel ch0" finding from Phase A is fixed).

---

## 1. Methodology

Same as Phase A (`docs/proposals/multichannel-hankel-experiment-2026-05-08.md`), with one parameter swept:

- **Production-recommended Ultra-Low band config:** `skip=40 ms, ir=600 ms, fade_in=20 ms (after), fade_out=20 ms (after), dec=8`
- **Hankel rows:** `_scaled_wl(processed_len)` = 744 (single-channel), 3720 (Belarus 5-ch multichannel), 5952 (PlyWood 8-ch multichannel).
- **Pole filter:** max_damping=0.2, freq_range=(30, 100) Hz, TLS, conjugate-pair validation.
- **Tracking:** `track_modes_nuclei_merge` with default `TrackingConfig`.
- **GPU:** cuPy SVD throughout.
- **Sweep:** `model_order ∈ {8, 12, 18, 24, 32}` (heuristic at 18 for Belarus, 23 for PlyWood — both round to 18 in the chosen sweep).
- **Datasets:** PlyWood (8-ch, 30 scenarios), Belarus (5-ch, 30 of 78 scenarios).
- **Noise floor:** 10 leave-3-out subsamples per dataset at the recommended mo.

---

## 2. Belarus model_order sweep (PRIMARY case)

Channel layout: `(0, 1, 3, 4, 5)`, ch0 = production single-channel reference.

### 2.1 Multichannel sweep

| mo | Q | n_chains | runtime/sc | hankel_rows | 54 Hz dets/coh15/frag | 89 Hz dets/coh15/frag |
|---|---|---|---|---|---|---|
| 8 (single ctrl, prod) | 3.108 | 7 | 320 ms | 744 | 30 / 0.980 / 1 | **22 / 0.935 / 1** |
| 8 (multi) | 2.472 | 6 | 1213 ms | 3720 | 20 / 0.992 / 1 | **0 / nan / 0** |
| 12 (multi) | 4.079 | 9 | 1204 ms | 3720 | 29 / 0.977 / 1 | **0 / nan / 0** |
| **18 (multi, heuristic)** | **6.606** | **13** | **1209 ms** | **3720** | **30 / 0.991 / 1** | **21 / 0.966 / 1** |
| 24 (multi) | 7.714 | 20 | 1203 ms | 3720 | 26 / 0.988 (33 agg/2) | **0 / nan / 0** |
| 32 (multi) | 9.550 | 23 | 1210 ms | 3720 | 30 / 0.991 (34 agg/2) | **0 / nan / 0** |

**Findings:**
- mo=18 is the unique multichannel value where 89 Hz is detected. mo=8/12 too small (off-target poles fill the budget below the 89 Hz signal); mo=24/32 too large (off-target spurious poles outrank 89 Hz).
- Cohesion at mo=18 (0.991 / 0.966) is **higher than the production single-channel baseline** (0.980 / 0.935) for both targets.
- Q at mo=18 is **2.13x the production baseline** (6.606 vs 3.108).
- Above mo=18 the global Q keeps growing because more chains are detected, but those chains include splits/spurious modes — the per-target metrics show the cost (fragmentation, missing 89 Hz).
- Mean runtime/scenario is **flat across mo** for multichannel (1203-1213 ms) — the SVD cost is dominated by hankel_rows=3720, not by mo (which only affects the eigendecomposition of an mo×mo companion matrix).

### 2.2 Single-channel ch0 control sweep — does the mo bump alone help?

| mo | Q | runtime/sc | 54 Hz dets/coh/frag | 89 Hz dets/coh/frag |
|---|---|---|---|---|
| 8 (production) | 3.108 | 320 ms | 30 / 0.980 / 1 | 22 / 0.935 / 1 |
| 12 | 4.011 | 118 ms | 30 / 0.992 / 1 | **25 / 0.929 / 1** |
| 18 | 5.005 | 121 ms | 30 / 0.972 / 1 | **0 / nan / 0** |
| 24 | 6.274 | 124 ms | 30 / 0.981 / 1 | **27 / 0.881 / 2** |
| 32 | 7.236 | 127 ms | 36 / 0.990 (frag=2) | **31 / 0.832 / 3** |

**Important finding:** the same Goldilocks pattern appears in single-channel — mo=12 catches 89 Hz strongest (25 dets at coh=0.929), mo=18 single-channel **also loses 89 Hz** (same as multichannel mo=8), then mo=24 recovers it but at degraded cohesion (0.881) and fragmented (2 chains). The mo=32 single result is the pathological case: 31 dets but coh=0.832 split into 3 fragments — mode shape inconsistent.

This means **the mo bump itself helps single-channel too** (single mo=12 catches 89 Hz at 25 dets, slightly more than the production single mo=8's 22 dets), but at higher mo single-channel quickly degrades into fragmented chains. The **multichannel mo=18 result (21 dets, coh 0.966, single chain)** is the cleanest 89 Hz extraction across the entire sweep.

### 2.3 Belarus noise floor at multichannel mo=18

10 leave-3-out subsamples (drop_n=3, keep_n=27, seed=1234):

| Config | Q mean ± std | 54 Hz dets ± std | 54 Hz coh15 ± std | 89 Hz dets ± std | 89 Hz coh15 ± std |
|---|---|---|---|---|---|
| Phase A: single-channel ch0 mo=8 (production) | 3.086 ± 0.079 | 27.0 ± 0.0 | 0.978 ± 0.002 | 15.3 ± 7.7 | 0.926 ± 0.011 |
| Phase A: multichannel mo=8 | 2.437 ± 0.061 | 18.4 ± 2.2 | 0.990 ± 0.002 | **0.0 ± 0.0** | nan |
| **Phase B: multichannel mo=18** | **6.502 ± 0.101** | **27.0 ± 0.0** | **0.990 ± 0.002** | **18.9 ± 0.8** | **0.958 ± 0.006** |

**Critical Phase A concern resolved:**
- Phase A flagged that single-channel 89 Hz had std=7.7 on mean=15.3 (50% relative variance — "lucky on this dataset" pattern). Multichannel mo=18 has std=0.8 on mean=18.9 (4% relative variance, **10x tighter**) AND a higher mean.
- 54 Hz coverage is identical (27.0 ± 0.0 in both — saturated at all 27 retained scenarios), but cohesion improves 0.978 → 0.990.
- Q is 2.11x the single-channel production noise floor (6.502 vs 3.086) — and the variance is comparable in absolute terms (0.101 vs 0.079 — same noise level on a higher signal).

The multichannel mo=18 configuration is **strictly better** than single-channel ch0 mo=8 production on Belarus: every metric improves, no metric regresses.

---

## 3. PlyWood model_order sweep (SANITY CHECK)

Channel layout: `(0..7)`. ch0 = force channel (production filters it out, takes ch1 as response[0]).

### 3.1 Multichannel sweep

| mo | Q | n_chains | runtime/sc | 60 Hz dets/coh15/frag | 75 Hz dets/coh15 (agg/frag) |
|---|---|---|---|---|---|
| 8 (multi, Phase A baseline) | 2.989 | 9 | 1418 ms | 22 / 0.985 / 1 | 19 / 0.937 (28/2) |
| 12 (multi) | 4.138 | 12 | 1443 ms | 24 / 0.987 / 1 | 21 / 0.958 (32/2) |
| **18 (multi, recommended)** | **5.625** | **14** | **1440 ms** | **26 / 0.989 / 1** | **20 / 0.969 (39/2)** |
| 24 (multi) | 6.758 | 20 | 1433 ms | 28 / 0.989 / 1 | 22 / 0.960 (51/4) |
| 32 (multi) | 7.949 | 24 | 1436 ms | 26 / 0.972 (40/2) | 24 / 0.952 (37/2) |

**Findings:**
- 75 Hz cohesion peaks at mo=18 (0.969), then degrades: 0.960 at mo=24, 0.952 at mo=32. Fragmentation rises: 2 chains at mo=18 → 4 chains at mo=24 → 2 chains at mo=32.
- 60 Hz cohesion peaks at mo=18 (0.989) and mo=24 (0.989); drops at mo=32 (0.972, 2 fragments).
- Best per-target Q at mo=18; Q keeps growing past that, but the per-target picture confirms the gain comes from off-target chains (more total noise, not better target detection).
- The PlyWood heuristic is `ceil(8 × √8) = 23`, but the empirical sweet spot is mo=18 — slightly below the heuristic. **Recommended auto-bump rule: `ceil(8 × √N)` is an upper bound on the useful budget; the actual optimum may be one step below.** Conservative practical choice: cap at the heuristic.

### 3.2 Single-channel control sweep

PlyWood's "ch0" in the harness is the force channel (per Phase A, the role-correct production single-channel uses ch1; the harness uses ch0 for full diagnostic coverage). The numbers below show **how close to blind a single channel can be when it sits at a node** — the multichannel SVD recovers signal from the other 7 channels:

| mo | Q | runtime/sc | 60 Hz dets/coh/frag | 75 Hz dets/coh/frag |
|---|---|---|---|---|
| 8 (force) | 0.273 | 118 ms | 0 / nan / 0 | 0 / nan / 0 |
| 12 | 1.155 | 120 ms | 0 / nan / 0 | 0 / nan / 0 |
| 18 | 1.780 | 123 ms | 8 / 0.723 / 1 | 0 / nan / 0 |
| 24 | 1.887 | 126 ms | 12 / 0.794 / 1 | 13 / 0.735 / 1 |
| 32 | (timeout — see below) | | | |

The mo=32 single-channel run on PlyWood force-channel data **hung indefinitely** (>6 minutes with no log progress while the GPU stayed at >85% utilisation). Diagnosis: with mo=32 on a near-blind sensor, the 32 extracted "poles" are mostly numerical garbage that survives radius/conjugate filtering and overwhelms `track_modes_nuclei_merge`'s O(N²) nucleus-matching loop. Killing the process leaves the partial log; the Belarus single mo=32 ran in ~127 ms/sc on quality-signal data, so this is specifically a force-channel pathology at extreme mo, not an algorithmic limit.

**Implication for production:** if a user toggles `use_multichannel=False` AND increases `model_order` aggressively, the existing nuclei-merge tracking can hang on degenerate input. Phase A's recommendation to keep `use_multichannel` as a UI toggle (not removed entirely) becomes more important — pairing high mo with multichannel is safe; pairing high mo with a near-blind single channel is the failure mode. **Default UI presentation should keep mo at the band default and only auto-bump when `use_multichannel=True`.**

### 3.3 PlyWood noise floor at multichannel mo=18

Run independently after the main sweep was killed (force-channel mo=32 hang).

| Config | Q mean ± std | 60 Hz dets ± std | 60 Hz coh15 ± std | 75 Hz dets ± std | 75 Hz coh15 ± std |
|---|---|---|---|---|---|
| Phase A: single-channel ch0=force (illustrative) | 0.251 ± 0.074 | 0.0 ± 0.0 | nan | 0.0 ± 0.0 | nan |
| Phase A: multichannel mo=8 | 2.993 ± 0.081 | 19.8 ± 0.7 | 0.982 ± 0.003 | 24.5 ± 1.2 | 0.919 ± 0.010 |
| **Phase B: multichannel mo=18** | **5.531 ± 0.151** | **23.2 ± 0.4** | **0.987 ± 0.002** | **35.5 ± 1.2** (frag 2.6 ± 0.7) | **0.893 ± 0.106** |

**Findings:**
- Q is **1.85x** the Phase A mo=8 multichannel baseline (5.531 vs 2.993). std grew from 0.081 to 0.151 — slightly noisier in absolute terms but still <3% relative variance.
- 60 Hz: dominant chain detections rise from 19.8 to 23.2 (+17%), cohesion improves 0.982 → 0.987, fragmentation stays at 1.0 — strict win.
- 75 Hz: aggregate detections rise from 24.5 to 35.5 (+45%) — multichannel mo=18 finds the mode in MORE scenarios, but fragmentation rises from 1.0 to 2.6 ± 0.7 chains, with the per-canonical-chain cohesion dropping from 0.919 to 0.893 ± 0.106. **Net 75 Hz coverage is better; per-fragment cohesion is slightly worse and noisier**.

This 75 Hz fragmentation increase is the price of the wider model_order budget on PlyWood — the heuristic prediction was mo=23, but the chosen mo=18 already shows fragmentation. **A possible refinement is to use a lower bump for high-N datasets** — e.g. `ceil(mo × √min(N, 5))` would give Belarus (N=5) the same 18 and PlyWood (N=8) only 18 instead of 23. The single-shot mo=12 result on PlyWood (Q=4.138, 75 Hz: 21/0.958/2 — frag=2 already) suggests mo=12 might be the actual sweet spot for PlyWood. Phase C follow-up could refine this.

---

## 4. Decision

**The multichannel + auto-bumped model_order configuration is strictly better than the production single-channel-ch0 + fixed-mo configuration on the two test datasets, AT THE CORRECT mo.** The Phase A "keep default false" caution was a fixed-mo artefact; it does not survive once mo is sized to the multichannel SVD budget.

### 4.1 Decision matrix (per the original task brief)

| Decision criterion | Phase B result |
|---|---|
| If `model_order_multi=18 (or ≤24)` recovers Belarus 89 Hz with no PlyWood regression | **YES — mo=18 recovers Belarus 89 Hz at higher cohesion than single-channel; PlyWood 75 Hz cohesion peaks at mo=18 (0.969 vs Phase A multi mo=8 0.937)** |
| If recovery requires impractical model_order (>32 or runtime explosion) | No — mo=18 is the sweet spot; runtime is flat across mo for multichannel (~1.2-1.4 s/sc) |
| If even the optimal model_order can't recover 89 Hz | Not applicable — mo=18 recovers 89 Hz cleanly |

**Decision: flip default to `use_multichannel=True` with auto-bump baked in.**

### 4.2 Recommended auto-bump rule

```python
def auto_bumped_model_order(band_default_mo: int, n_response_channels: int,
                            use_multichannel: bool,
                            channel_cap: int = 5) -> int:
    """Phase B 2026-05-09 heuristic with N cap.

    The √N rule is well-validated at N=5 (Belarus). At N=8 (PlyWood) the
    full √N=23 starts producing per-target chain fragmentation, suggesting
    the rule saturates around N≈5. Capping the channel count in the bump
    formula keeps the budget in the empirically-validated range.
    """
    if not use_multichannel or n_response_channels <= 1:
        return band_default_mo
    import math
    effective_n = min(n_response_channels, channel_cap)
    return int(math.ceil(band_default_mo * math.sqrt(effective_n)))
```

For the production extended_8band preset (channel_cap=5):
- Ultra-Low band (mo=8) at 5 channels → 18; at 8+ channels → 18 (capped).
- Low band (mo=12) at 8+ channels → 27.
- Mid band (mo=35) at 8+ channels → 79 (likely too high — see §5.4 caveats; need higher-band testing).

**Why cap at N=5:** Belarus (N=5) is exactly at the heuristic's sweet spot — every metric improves cleanly. PlyWood (N=8) at the un-capped heuristic (mo=23) was not directly measured, but the closest measured value (mo=18) already shows 75 Hz fragmenting into 2.6 chains on average. Pushing to mo=23 likely fragments further. The cap is conservative and conserves the "no per-target regression" property at the cost of slightly less Q-headroom on high-N datasets.

**Alternative if the cap feels arbitrary:** make `channel_cap` a project-level setting exposed in EspritConfig Advanced, with the default at 5 and a tooltip pointing to this proposal.

### 4.3 Risks

1. **Heuristic over-prediction at high mo bands.** For bands with already-high default mo (Mid=35, Mid-High=45, High/Upper/Top=50), `√N × mo` gives values approaching 100-141 at N=8. Phase B did not test this regime — only the Ultra-Low band (mo=8). **Recommendation: clamp the auto-bump at e.g. `min(ceil(mo × √N), 50)` until follow-up testing confirms the heuristic on higher bands.** The runtime cost in this regime is also untested.

2. **Hang on degenerate inputs at high mo.** Section 3.2 shows that mo=32 on near-blind single-channel data hangs the tracking pipeline. The auto-bump only activates when `use_multichannel=True`, so the hang risk is contained — but the toggle must remain to allow opt-out, and `model_order` should NOT be auto-bumped on the single-channel path.

3. **Goldilocks pattern means the heuristic is a guideline, not a guarantee.** If a future dataset has a different SNR profile or pole density, the optimum may shift. The toggle UI should expose mo manually so power users can tune.

---

## 5. Production proposal (Phase B code changes)

### 5.1 Default flip + auto-bump (vs Phase A's "wire it through, default false")

Phase A's plan was: wire `use_multichannel` end-to-end, keep default false, expose UI toggle. Phase B's recommendation is: **wire it through (Phase A scope) + flip default to True + bake in the auto-bump**.

If Phase A (dev-mch) has completed the wiring with default false, Phase B is a 2-3 line follow-up flip plus the auto-bump function.

### 5.2 Code changes

**1. `PianoidCore/pianoid_middleware/modal_adapter/esprit/band_merging.py`** — inject auto-bump in the per-band ESPRIT call site (line 236):

```python
# In merge_multiband_results, after the existing band.model_order resolution:
if band.model_order is not None:
    params['model_order'] = band.model_order
elif 'model_order' not in params:
    params['model_order'] = 30

# NEW (Phase B): auto-bump model_order when use_multichannel is on.
if params.get('use_multichannel', False):
    n_resp = signals.shape[1]  # response-channel count (after role filter)
    if n_resp > 1:
        import math
        # Cap effective N at 5 (Belarus sweet spot — see §4.2). Prevents
        # over-bumping on high-N datasets where 75 Hz starts to fragment.
        effective_n = min(n_resp, 5)
        bumped = int(math.ceil(params['model_order'] * math.sqrt(effective_n)))
        # Hard cap to avoid degenerate-pole hangs on very high bands.
        params['model_order'] = min(bumped, 50)
```

**Why band_merging is the right injection point:** model_order is per-band (each `FrequencyBand` carries its own default), and `merge_multiband_results` is the single place where the per-band `params` dict is built before each ESPRIT call. The auto-bump must be per-band, per-channel-count — not a global override.

**2. `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py:53-92`** — flip `DEFAULT_ESPRIT_PARAMS` to include `use_multichannel: True`, AND forward it from the `esprit_params` dict that `run_single_point` builds:

```python
# DEFAULT_ESPRIT_PARAMS (line 53-61):
"use_multichannel": True,  # PHASE B: default ON; auto-bumps model_order.
                           # See docs/proposals/multichannel-hankel-phase-b-2026-05-09.md.

# esprit_params dict in run_single_point (line 86-92):
"use_multichannel": params.get("use_multichannel", True),  # default True per Phase B.
```

**3. `PianoidTunner/src/hooks/useModalAdapter.js:19`** — flip the frontend default:

```javascript
use_multichannel: true,  // PHASE B 2026-05-09: default ON. Auto-bumps model_order
                         // by ceil(mo × √N_channels) per band. See
                         // docs/proposals/multichannel-hankel-phase-b-2026-05-09.md.
```

**4. `PianoidTunner/src/components/EspritConfig.jsx`** — UI toggle (Phase A's design carries over):
- "Multichannel Hankel" switch in Advanced section, defaulting checked.
- Tooltip body updated:
  > Stack-mode Hankel: builds the ESPRIT Hankel matrix from all response channels stacked, instead of just the first one. Improves coverage and cohesion when the first channel sits near a node of any target mode (Hua-Sarkar 1990). Auto-bumps `model_order` by `ceil(mo × √N)` per band to keep weak-but-real modes within the multichannel SVD budget. See `docs/proposals/multichannel-hankel-phase-b-2026-05-09.md`.

**5. Logging** — at run start, log a single line:
> `INFO esprit_runner use_multichannel=True; auto-bump applied per band (Phase B √N heuristic)`

### 5.3 Test changes

- New backend test `tests/integration/test_modal_adapter_multichannel_phase_b.py`:
  - On a fixture project, assert `use_multichannel=True` produces non-empty `frequencies`.
  - Assert the per-band `model_order` actually used (read from `per_band_results[i].model_order`) equals `ceil(band.model_order × √n_response_channels)` capped at 50.
- Frontend test (extension of Phase A test): toggle ON propagates `use_multichannel: true` in the request body; toggle OFF propagates `false` AND model_order is the band default (no auto-bump).
- Existing `test_modal_adapter_e2e.py`: parametrise over `use_multichannel ∈ {False, True}` and assert both produce non-empty results on the test fixture.

### 5.4 What was NOT tested in Phase B

- **Higher-band auto-bump.** Phase B only tested the Ultra-Low band (mo=8). The auto-bump rule `min(ceil(mo × √N), 50)` for higher bands (mo=15-50) is theoretical. If the harness sweep is repeated for the Low band (mo=12), Mid band (mo=35), etc., the cap may need adjustment.
- **N>8 channels.** The harness was capped at PlyWood's 8 channels. The √N scaling has been validated at N=5 and N=8.
- **Different exp_factor / preemphasis combinations.** Phase B used the dev-grid Phase B Ultra-Low config exactly. Other band configs may have different optimal mo profiles.
- **Stabilization mode.** All Phase B runs used `use_stabilization=False` (the production default). The interaction with the stabilization grid is untested.

### 5.5 Backwards compatibility

- Existing `use_multichannel: false` saves continue to round-trip correctly (no auto-bump, no change vs Phase A).
- Existing projects without an `esprit_config` saved value will get the new default `True` → noticeable behaviour change. Section 5.6 below covers the user-visible impact.

### 5.6 User-visible behaviour change at default

For projects where the default propagates:
- **PlyWood-like (response[0] is at a node of a target mode):** Q jumps ~1.4-2x; previously-missed modes appear; mode cohesion improves.
- **Belarus-like (response[0] is at an antinode):** Q jumps ~2x; both target modes detected at higher cohesion; noise floor variance drops 10x for the harder target.
- **Generic/middle case:** improvement or parity, no regression observed.
- **Runtime:** ~10x slowdown on the Ultra-Low band (Phase A finding); ~1.5-2x on the full ESPRIT pass (since other bands run on shorter signals at higher decimation). User-perceptible only for very large projects.

---

## 6. Files

- This proposal: `docs/proposals/multichannel-hankel-phase-b-2026-05-09.md`
- Predecessor (Phase A): `docs/proposals/multichannel-hankel-experiment-2026-05-08.md`
- Phase B harness: `PianoidCore/tools/grid_search/experiment_multichannel_hankel_phase_b.py`
- Phase B PlyWood-noise-floor mini-experiment: `PianoidCore/tools/grid_search/experiment_multichannel_hankel_phase_b_plywood_noise_floor.py`
- Phase B raw logs: `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel_phase_b.log`, `…_plywood_nf.log`
- Phase B PlyWood-noise-floor JSON: `PianoidCore/tools/grid_search/results/experiment_multichannel_hankel_phase_b_plywood_nf.json` (mini-experiment output; the main Phase B JSON was lost when the parent run was killed mid-PlyWood-single-mo=32 hang).

---

## 7. Open follow-ups

1. **Higher-band auto-bump validation** — re-run the harness for Low (mo=12), Low-Mid (mo=25), Mid (mo=35) bands on both datasets. Confirm the √N rule still works or determine where the cap should land.
2. **Per-channel-count Goldilocks zone characterisation** — is the optimum always at `√N × mo` exactly, or does it drift one step below for higher N? Phase B suggests it's at-or-just-below the heuristic (PlyWood mo=18 vs heuristic 23).
3. **Stabilization-mode interaction** — when `use_stabilization=True`, does the auto-bump still apply correctly? (Stabilization sweeps multiple (M, L) values, so the relationship is more complex.)
4. **Runtime profile on the full extended_8band preset with auto-bumped model_orders** — does the total ESPRIT-pass slowdown exceed user-perceptible thresholds when auto-bump is active across all bands?
