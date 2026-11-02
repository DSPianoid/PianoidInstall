# Tuning latency, Phase 1 (1a, 1d, 1e) + Phase 3 (3a, 3b): review (2026-10-28, dev-elat1)

**Status:** implemented on feature branches, NOT merged. Approved order: user, 2026-10-28 ("Yes go with
this order"). Source study: [tuning-latency-study-2026-10-23](tuning-latency-study-2026-10-23.md).
Phase 1b, 1c and Phase 2 are not in this change.

| Repo | Branch | Commit |
|---|---|---|
| PianoidCore | `feature/dev-elat1-excitation-latency` (rebased on dev 27dc2a1) | d740702 |
| PianoidTunner | `feature/dev-elat1-commit-on-enter` | df343da |
| PianoidInstall | `feature/dev-elat1-docs` | (this doc, docs, harness) |

Python and JS only. No `.cu`/`.cpp`/`.h` change, so no rebuild is needed (Core = LIGHT; Tunner = CRA).

## What changed

| Item | Change | Where |
|---|---|---|
| 1a | An excitation write is ONE blob upload (`setNewExcitationBaseLevels`) whatever the pitch count. The per-string path (`updateExcitationBaseLevelsForString`, one ~4 ms swap per unison string, 24 swaps for 8 pitches) is no longer used. | `parameter_manager._upload_excitation_curves` |
| 1d | `CoefficientCache.recompose` is split into `prepare` (compute the table, no engine write) and `commit` (`setNewExcitationCoefficients`). ParameterManager runs prepare → upload (one swap) → wait for the swap → commit, for gauss, hammer and `update_pitch_excitation`. The wait polls `isParameterUpdateInProgress()` with `time.sleep(0.0002)`, so it does not hold the GIL (`waitForParameterUpdate` does). | `excitation_coefficients.py`, `parameter_manager._upload_then_commit_coefficients` |
| 1e | `time.sleep(0)` once per pitch in the gauss `load_from_dict` loop, the hammer `update_hammer_shape` loop and the curve recompose loop. | same |
| 3a | Enter in a `NumInput` runs its commit inside `utils/explicitCommit.runAsExplicitCommit`. In that synchronous scope `writeParam` cancels the pending debounced write of the same key and sends at once, inside the keydown handler, before React re-renders. | `NumInput.js`, `usePreset.writeParam`, `utils/explicitCommit.js` |
| 3b | Inside the same scope `useStagedParamEdits.stage` commits without the 150 ms settle (hammer Pos/Width/Sharp fields). Wheel and drag keep the settle. | `useStagedParamEdits.js` |

Deck (feedin/feedback/sound-channel) and hammer per-row/per-block paths are unchanged: the approved
1a numbers are for excitation. The hammer per-block path is already one swap for a few pitches.

## Data-model facts (confirmed)

- `excitation_coefficients_` is a host table that is live at the next note the moment
  `setNewExcitationCoefficients` returns, with no swap. **Measured:** a ×0.5 table with no upload
  rendered the next note at ×0.4999980–×0.5000030 (5 runs). The curve is live only after its swap is
  adopted. This is now in SYNTHESIS_ENGINE "Excitation Parameter Storage" and DATA_FLOWS §2.2.
- `levels_matrix` 128×4×5, 6 base levels, C++ per-string interpolation: DATA_FLOWS §2.2,
  SYNTHESIS_ENGINE (unchanged).

## Bit-identical evidence (offline, audio_off, in-process)

Harness: `docs/development/diagnostics/dev-elat1/dev-elat1-offline.py` + `dev-elat1-compare.py`.
Preset `Tuning18-10-26ver1`, array 512, si 8, cycle 64. Eight cumulative edits (gauss n1, n1, n8,
n12, n88; hammer n1, n12, n88). After each edit, p60 v127, p57 v95 and p100 v63 are rendered offline.
The harness keeps the coefficient table and gaussKernel's force function (`fetchExcitation`) of
every struck string.

| Compare | Coefficient tables | Force functions | Rendered audio (max rel diff) |
|---|---|---|---|
| base vs base (same code, 2 processes) | 8/8 identical | 24/24 identical | 3.3e-5 |
| after vs after | 8/8 identical | 24/24 identical | 4.2e-5 |
| base vs after (4 pairs) | **8/8 identical** | **24/24 identical** | 3.6e-5 to 4.2e-5 |

The rendered audio is not bit-reproducible even with identical code. MainKernel and FIRFilter sum
with float `atomicAdd`, so the summation order varies at about 3e-5 relative (about −90 dB). Everything
that feeds synthesis is bit-identical, and before-vs-after audio sits inside the same-code floor.

## Latency

All measurements were taken on the new binary (Core dev 27dc2a1 + late1/ncap1/excitdoc C++), on a quiet machine,
following the study's method. BEFORE = Core dev 27dc2a1 / Tunner dev 908e500; AFTER = these branches. Values are median [min-max].

### Live, loopback Out 9 → In 8 (exp04: strike p60 v127 d ms after a WS write, N = 3 per d)

| Case | first all-new d, BEFORE → AFTER | mixed strikes, BEFORE → AFTER | WS ack ms, BEFORE → AFTER |
|---|---|---|---|
| gauss, 1 pitch | 20 → 20 | 6 of 6 at d = 5, 10 → **0** | 21.5 [18.5-27.2] → 20.4 [18.1-26.6] |
| gauss, 8 pitches | 160 → **80** | 3 at d = 80 → **0** | 162.7 [147.8-414.6] → **67.9** [64.0-218.0] |
| gauss, 88 pitches | 640 → 640 | 3 at d = 320 → **0** | 642.9 [572.2-827.9] → 630.7 [575.7-856.2] |
| hammer position, 1 pitch | 5 → 5 | 5 at d = 0, 2 → 1 at d = 0 | 7.0 [6.4-9.2] → 11.1 [9.6-23.8] |
| hammer position, 88 pitches | 80 → **160** | 0 → 0 | 105.4 [100.6-109.7] → 108.5 [102.9-117.0] |

The d grid is 0, 2, 5, 10, 20, 40, 80, 160, 320 and 640 ms, so "all-new" is quantised to it. A strike now plays
either the old excitation or the new one. Hammer, 88 pitches: the coefficient is prepared before the upload,
so the hammer swap lands about 30 ms later than before. In exchange the curve and the coefficient arrive
together. The 88-pitch gauss cost is the pure-Python model rebuild and recompose (Phase 1b/1c, not in this
change).

### Live, notes during a write (exp08: WS NOTE_ON p72 X ms after the write starts, send → In 8, N = 3)

| Write in flight | X = 10 | X = 50 | X = 150 |
|---|---|---|---|
| idle baseline | 25.5 → 25.5 | | |
| gauss, 8 pitches | 29.2 → 29.4 | 23.4 → 18.9 | 19.3 → 18.9 |
| gauss, 88 pitches | 286.6 [245-329] → **80.0** [30-225] | 181.7 [108-194] → **97.7** [59-330] | 77.0 → 77.0 |
| hammer, 88 pitches | 64.2 [62-67] → 74.6 [60-75] | 36.1 → 41.5 | 20.2 → 19.2 |

`time.sleep(0)` cuts the median delay of a note sent during an 88-pitch gauss write by about 3.5× at X = 10
and 2× at X = 50, but the spread stays wide (max 225-330 ms). Offline, a GIL probe still sees single stalls of
50-150 ms inside the per-pitch model rebuild with and without the yields. `Sleep(0)` does not reliably hand
over the GIL. The ~30-40 ms target needs 1b/1c (less Python per write). Hammer, 88 pitches, is unchanged
within noise.

### Frontend (real CDP click + fill + Enter on the agent page, worktree CRA DEV build, N = 3)

| Control | Enter → WS frame, BEFORE | Enter → WS frame, AFTER |
|---|---|---|
| Excitation gauss volume NumInput | 212, 185, 176 ms | **11, 9, 7 ms** |
| Hammer position NumInput | 270, 282, 262 ms | **0.9, 0.5, 0.5 ms** |

The write now leaves inside the keydown handler. The page still re-renders afterwards (emit → ack seen in the
page: 143-223 ms), but the backend has the edit by then.

### Offline (in-process, audio_off, ParameterManager.update_parameter, N = 3 runs × 5)

| Case | uploads (swaps) | ms, BEFORE → AFTER | swap landed → coefficient live |
|---|---|---|---|
| gauss, 1 pitch | 3 → 1 | 142 → 63 | (set before the swap) → 0.34 ms |
| gauss, 8 pitches | 24 → 1 | 1670 → 110 | → 0.35 ms |
| gauss, 88 pitches | 1 → 1 | 624 → 672 | (≈350 ms apart) → 0.39 ms |
| hammer, 1 pitch | 1 → 1 | 3 → 62 | → 0.41 ms |

Offline, with no engine running, a swap takes about 50 ms, against about 4 ms live. That inflates every
offline "wait" figure. The live ack (hammer 1 pitch +4 ms) is the figure that counts.

## Tests

- Core (venv pytest): `test_excitation_write_order` (6, NEW; fails on the old code),
  `test_excitation_coeff_incremental` (9, +2), `test_hammer_rest_roundtrip` (12, mocks updated): 27 passed.
- Tunner Jest, full suite (`--maxWorkers=2`): 275 suites, 2334 passed, 1 skipped. New tests:
  `utils/explicitCommit`, `usePreset.explicitCommit`, `useStagedParamEdits.explicitCommit`, plus one case in
  `numInput.enterCommit`.
- Bit-identity: see above (offline, new binary, 3 BEFORE + 3 AFTER processes).

## Risks and follow-ups

- The post-upload swap wait adds one swap (~4 ms on an idle machine) to every gauss and hammer ack.
  It is bounded and GIL-free. On a machine at 100 % CPU the swap took 30–130 ms (the poll thread
  starves).
- `time.sleep(0)` helps the median but does not bound the worst case (see exp08). 1b/1c are the real fix.
- Hammer, 88 pitches, all-new moved 80 → 160 ms on the d grid: the trade for no mixed strikes. Option: prepare
  the factor after the upload, while the swap is in flight. The sound would be new sooner, but the mixed window
  would grow back to the prepare time (~30 ms at 88 pitches). Phase 2 (the coefficient rides the swap) removes
  this trade.
- Phase 2 (the coefficient riding the swap, atomic) removes the remaining ~1 ms mixed window.
