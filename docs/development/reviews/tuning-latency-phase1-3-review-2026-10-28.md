# Tuning latency, Phase 1 (1a, 1d, 1e) + Phase 3 (3a, 3b): review (2026-10-28, dev-elat1)

**Status:** implemented on feature branches, NOT merged. Approved order: user, 2026-10-28 ("Yes go with
this order"). Source study: [tuning-latency-study-2026-10-23](tuning-latency-study-2026-10-23.md).
Phase 1b, 1c and Phase 2 are not in this change.

| Repo | Branch | Commit |
|---|---|---|
| PianoidCore | `feature/dev-elat1-excitation-latency` | 226d003 |
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

LIVE_TABLES_PENDING

## Tests

TESTS_PENDING

## Risks and follow-ups

- The post-upload swap wait adds one swap (~4 ms on an idle machine) to every gauss and hammer ack.
  It is bounded and GIL-free. On a machine at 100 % CPU the swap took 30–130 ms (the poll thread
  starves).
- `time.sleep(0)` is `Sleep(0)` on Windows. When other equal-priority threads are ready, it can give
  away a quantum. See the measured n88 figures.
- Phase 2 (the coefficient riding the swap, atomic) removes the remaining ~1 ms mixed window.
