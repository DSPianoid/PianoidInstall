# Mode-scaling T3 — uniform flat tier (measurements, 2026-10-10)

**Agent:** dev-5bf7 · **Spec:** [4000-modes proposal §R.2 / §R.5 T3](../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md#r5-implementation-plan-next-dev-tasks-in-order)
· **Code:** PianoidCore `feature/dev-5bf7-flat-tier` (off dev 443d42c = T1 merged), PianoidBasic `feature/dev-5bf7-flat-pack`
(off dev a10c32e) · **Status:** implemented + verified; MERGED 2026-10-10 (Core dev 824dba5, Basic dev 2f1d072).
Reference docs: [SYNTHESIS_ENGINE → Uniform flat tier](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#uniform-flat-tier-flattiercuh-4000-modes-t3-dev-5bf7-2026-10-10),
[PianoidBasic OVERVIEW → Flat tier opt-in](../modules/pianoid-basic/OVERVIEW.md#flat-tier-opt-in-pack-contract-4000-modes-campaign-t3-dev-5bf7).

## 1. Design as implemented

**The split is exact; the approximation is a preset transform.** Decision Q2 (all modes above the 56 shaped ones
completely flat) is applied by PianoidBasic `mode_extension.flatten_preset` (real presets) or the T2 generator
(synthetic presets) — `a(m)` = mean piano-row deck column, `mass = a(m)²·mass_inv`, piano rows 1.0, output rows `w_c`
(LSQ readout). The engine split only refactors the coupling of columns that are already uniform, so
`flat tier ON` ≡ `flat tier OFF` on the same preset (measured, §2.2), and the A/B (§2.3) isolates exactly the Q2
approximation.

| Layer | Change |
|---|---|
| Opt-in | `model_parameters.flat_tier_num_shaped` / `flat_tier_num_flat` (default 0 = every existing preset runs the T1 full-deck path, verified equal to T1, §2.1) → `InitializationParameters` → `cycle_parameters[13]/[14]` |
| Mapping (`ModeLayout.cuh`) | shaped `[0, 56)` quarter 0 (F15: blocks 56/57 quarter 0 empty) · uniform `[56, 196)` owners `t = Q + f % U`, `U = 3`, slot −1, no deck slot · linked `[196, N)` (4 sound-channel mode slots + padding) via the T1 slot link, owners `t = Q + U + j` |
| Reductions (`FlatTier.cuh`) | feedback: block partial of `q'` → row `numStrings` of `feedback_cycle_matrix`; after the existing grid sync warp 0 sums 64 columns → `Q_sum`; stems `+= fb_scale(s)·w(s)·Q_sum`. Feedin: `Σ_k w(string_k)·force_k/soundStep` per block → row `numStrings` of `feedin_cycle_matrix` → `F_sum`; flat owners advance with `F_sum`. No new grid barrier |
| Readout | user default: output string `s` gets `w(s)·Q_sum` with `w(s) = w_c × SC string gain` (its packed row), unscaled by `deck_feedback_coeff` (the existing output-row rule) |
| Contract | `flat_tier.check_uniform_flat_row` in `StringMap.pack_pitch_feedin` (all deck upload paths): packed row not bit-uniform over the flat columns → `FlatTierError`; tier counts checked in `pack_as_dict_for_cuda`; engine `validateModeLayout` in `devMemoryInit` |
| Precision | fp32 tree sums (warp shuffles) — same structure as `sumArray`. A double cross-block stage cost the debug variant the 128-register cap (spill); Kahan/double deferred to a T4 accuracy check |

Not done (deferred): **deck width 56** — the full-width deck still carries the (uniform) flat columns; the kernel
reads only the shaped/linked columns + one flat column. Shrinking the packed width is a pack/alloc change that only
matters at T4 sizes.

## 2. Verification

Scratch binaries via `PYTHONPATH` (shared venv untouched): base = T1 (`bin_t1`, dev 443d42c content), T3 = worktree
`setup.py build_ext`; PianoidBasic from the branch wheel (`pip --target`). Harness
`docs/development/diagnostics/dev-5bf7-t3-harness.py`, report `dev-624c-t1-compare.py`, A/B `dev-5bf7-t3-ab.py`,
audit `dev-5bf7-ownership-audit.py`.

### 2.1 Zero flat modes — legacy path vs T1 (3 s chord C2–C6 ×2, N = 3 fresh processes each)

| Preset / artefact | base-base relRMS median (max) | base-T3 relRMS median (max) |
|---|---|---|
| Belarus audio | 1.885e-3 (1.891e-3) | 1.888e-3 (1.910e-3) |
| F15 audio | 1.012e-4 (1.015e-4) | 9.98e-5 (1.063e-4) |
| Belarus / F15 mode state | 2.9e-5 / 4.4e-5 | 4.5e-5 / 3.0e-5 |
| Belarus / F15 all-mode probe | 6.9e-5 / 7.6e-6 | 5.7e-5 / 1.3e-5 |

Mode config bit-identical. **Indistinguishable** — existing presets are unchanged.

### 2.2 Exact-math test — flattened preset, flat tier OFF (per-mode deck) vs ON (split), N = 3 each

| Preset | full-full | full-split | split-split |
|---|---|---|---|
| Belarus audio | 1.901e-3 | 1.811e-3 (max 1.822e-3) | 1.700e-3 |
| F15 audio | 1.021e-4 | 9.97e-5 (max 1.026e-4) | 9.92e-5 |

Mode state and probe inside the same bands. **The factorisation is exact to render noise.** Pinned by
`PianoidCore/tests/integration/test_flat_tier_exactness.py` (split within 3× measured full-vs-full noise) and the
numpy recurrence check in `PianoidBasic/tests/test_flat_tier.py`.
**Ownership audit** (debug, baked slots 25/27/28): Belarus/F15 legacy 224/232 owners, flat 224/232, 0 errors
(uniform modes: one owner each, slot −1, coupled by no quarter; linked: one coupling quarter each).

### 2.3 Listening A/B — source preset full deck (A) vs 56 shaped + 140 flat (B), T3 binary

WAVs (24.7 s: single notes 28/40/52/60/69/79/88/100, then C2 / C4 / C5 / C2–C6 chords; A and B share one gain):
`D:/scratch/dev-5bf7/wav/T3_AB_{Belarus,F15}_{A_fulldeck,B_flat56}_{stereo,4ch}.wav` (+ `*_ab_report.json`).

| | Belarus | F15 |
|---|---|---|
| channel level B − A (ch 1..4) | +0.02 / −0.06 / −0.06 / +0.06 dB | 0.00 dB |
| octave bands 31.5 Hz–16 kHz, ch 1 / ch 2 | within ±0.15 dB | 0.00 up to 1 kHz, −0.08…−0.21 dB 2–16 kHz (ch 1) |
| per segment (notes / chords) | ±0.3 dB | ≤ 0.1 dB |
| waveform relRMS | 5–6.5 % (segments 3–10 %) | 0.1–0.2 % |
| context: A vs the 140 upper modes **removed** | relRMS 9–11 %, HF octaves to −0.87 dB | relRMS 0.2 % |

Reading: on Belarus the flat tier keeps the upper modes' level/spectrum (±0.15 dB per octave vs up to −0.9 dB when
they are removed) while the per-mode coupling shapes it drops change the waveform by ~5–6 % — whether that is audible
is the user's call (§R.6). On F15 the 140 upper modes barely reach the output in these renders (removing them changes
0.2 %), so its A/B is weakly discriminating.

### 2.4 Registers, occupancy, timing

| `addKernel` | sm_80 | sm_86 | sm_89 |
|---|---|---|---|
| release T1 → T3 | 98→109 (T1 100) | 101→111 | 101→111 |
| debug T1 → T3 | 102→112 | 103→114 | 103→114 |

0 spill / 0 stack, smem 18 524 B (+28). Pre-flight: regs 111, 1 block/SM, capacity 128 ≥ grid 56/58. Cost breakdown
(sm_89 MainKernel-only compiles): owner-register `q` +1–2; the flat reductions +9–10; the strided form of the
cross-block loop had cost +14 more in debug (rewritten as `row[t] + row[t + 32]`).

Timing (addKernel CUDA events, 8 s chord after 1 s warm-up, run-mean per fresh process, two sets of N = 5 interleaved
rounds). A concurrent agent's backend synthesized intermittently, so runs are bimodal; quiet runs:

| Preset | T1 | T3 legacy | T3 split (56 + 140) |
|---|---|---|---|
| Belarus (384, si 4) | 472 µs (457–504, n 7) | 484 µs (+2.5 %, n 5) | **434 µs (−8 %, n 4)** |
| F15 (512, si 16) | 969 µs (957–975, n 4) | 975 µs (+0.6 %, n 4) | **935 µs (−3.5 %, n 3)** |

Contended runs show the same order (Belarus 686 / 693–787 / 640–655 µs; F15 1300 / 1300–1340 / 1260–1290 µs).
The split is faster: quarters 1–3 run one linked deck slot per block instead of three, and the two reductions
cost less than the two removed per-mode scatters.

### 2.5 Tests

PianoidBasic `tests/` 52/52 (35 T2 + 17 new `test_flat_tier.py`). Core `tests/integration/test_flat_tier_exactness.py`
2/2 (46 s). Core `tests/unit` (`-k "not esprit"`, `test_band_processing_skip.py` ignored, T3 binaries + branch PianoidBasic):
**1934 passed / 4 failed (pre-existing `test_start_right_away_binary`) / 1 skipped** — identical to the T1 baseline.

## 3. Readiness for T4 (N ≈ 2000 with the generator presets)

- **Opt-in exists for generated presets:** `synthetic_modes ... --flat-tier` (generator output already meets the
  uniformity contract, verified on the N = 220 / 228 smoke presets).
- **Layout scales:** at N = 2000, `U = ceil(1944/56) = 35` flat owners per block ≤ `3Q − L` (287 / 383); one mode per
  thread → no per-mode registers; reduction cost is N-independent except the block-partial warps (≤ 2).
- **T4 must still do:** `NUM_MODES` / `dev_mode_running` / `MODE_STATE_SIZE` / deck region sizing (all ≤ 256 today);
  decouple the engine mode count from `num_strings` (`pianoid.py` `num_modes_for_model = num_strings`,
  `ModelParameters.set_num_modes` / `ModeMap.set_sound_channels` guards, `pack_pitch_feedin` pads rows to
  `num_strings`); pack the deck at width `nS + 1 + linked` (or size the tunable deck region for N); a float64-reference
  accuracy check of `Q_sum` / `F_sum` at N = 2000 (Kahan/double only if needed — register budget 111/114 of 128).
- **UI (T5):** a flat-column deck edit or mute now fails the upload loudly (by design); the editors should show the
  flat tier as one aggregated band.
