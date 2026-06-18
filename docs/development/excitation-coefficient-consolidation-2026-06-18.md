# Excitation-coefficient update — consolidated single-path architecture (2026-06-18)

**Agent:** dev-excenergy · **Status:** implemented (held for user test) · physics-energy B2 (D9)

## Problem (measured)

Parameter edits that move an excitation-coefficient factor had **divergent, inconsistent**
update paths, and the slow ones blew the user's 50 ms latency budget:

| Param | Path (before) | Latency (cycling, measured) |
|---|---|---|
| hammer width / sharpness / position | incremental (one-off `update_excitation_coefficients_for_hammer`) | ~1.8 ms |
| hammer **mass** (per-pitch) | FULL rebuild (`/excitation_energy` → `upload_excitation_coefficients`) | **523 ms** |
| energy **speed** (per-level) | FULL rebuild (`/excitation_energy`) | **523 ms** |
| **calibration** c (global) | FULL rebuild (`/excitation_energy`) | **523 ms** |
| gauss **curve** shape | FULL rebuild (gauss branch) | **523 ms** |

The 523 ms is dominated by `StringMap.pack_excitation_coefficients` (500 ms): it loops **all
84 key pitches × 6 levels** and calls `pitch.excitation.level_impulse(level)` (the GPU-formula
temporal point-sum) for every one. The GPU upload itself is 0.23 ms (direct, not double-buffered).

Root issue is architectural (user: "same fix in several places = code not consolidated"): the
coefficient is a **pure product** `c · mass · speed · temporal · spatial`
(`StringExcitation.compose_excitation_coefficient`), so every single-factor edit is an exact
rescale — but only the hammer-spatial factor had been wired incrementally.

## Architecture (single path + factor cache)

```
StringMap.pack_excitation_factors()   -> {'c', 'levels', 'speed':[6],
                                          'pitch': {pid: {'mass', 'spatial', 'temporal':[6]}}}
StringMap.compose_from_factors(f)     -> {pid: [6 coeffs]}   (cheap product)
pack_excitation_coefficients()        =  compose_from_factors(pack_excitation_factors())  (unchanged behaviour)
```

`excitation_coefficients.CoefficientCache` is the **single owner** (P1) of the live flat GPU
table + the separated factors. ONE entry point:

```
cache.recompose(cuda, sm, changed)   # changed = {'kind': 'mass'|'spatial'|'curve', 'pitches':[...]}
                                     #         | {'kind': 'speed'} | {'kind': 'calibration'}
```

It re-reads ONLY the moved factor (cheap scalar; `temporal` re-runs `level_impulse` for the
edited pitch ONLY on a curve edit), recomposes the affected base rows, re-extrapolates 6→128
with the same `extrapolate` the curves use, splices into the cached flat table, and uploads.
The **full rebuild is now the preset-load special case** (`cache.seed` = recompose-all).

Every coefficient-affecting edit routes here:

| Edit | `changed` | Cost |
|---|---|---|
| mass (per-pitch) | `{'kind':'mass','pitches':[…]}` | scale that pitch's row |
| hammer width/sharpness/position | `{'kind':'spatial','pitches':[…]}` | scale that pitch's row |
| gauss curve | `{'kind':'curve','pitches':[…]}` | recompute that pitch's temporal only |
| speed (per-level) | `{'kind':'speed'}` | recompose all rows (no temporal) |
| calibration c (global) | `{'kind':'calibration'}` | recompose all rows (no temporal) |

Wiring: `parameter_manager.update_parameter` hammer + gauss branches and `backendServer
/excitation_energy` (mass/speed/calibration) all call `_recompose_excitation_coefficients` /
`cache.recompose`. `pianoid._upload_excitation_coefficients` (load path) seeds the cache so the
first subsequent edit is already incremental. Deleted: the divergent
`update_excitation_coefficients_for_hammer` + `_string_rows_for_pitch` + the per-branch
full-rebuild calls.

## Result (measured, offline audio_off, Belarus_196modesC)

| Edit kind | recompose | +1.33 ms cycling floor | <50 ms? | max\|incr − full rebuild\| |
|---|---|---|---|---|
| mass | 0.42 ms | 1.76 ms | ✅ | 0.000e+00 |
| spatial (hammer) | 0.42 ms | 1.75 ms | ✅ | 0.000e+00 |
| curve | 6.10 ms | 7.44 ms | ✅ | 0.000e+00 |
| speed | 23.96 ms | 25.29 ms | ✅ | 0.000e+00 |
| calibration | 23.85 ms | 25.18 ms | ✅ | 0.000e+00 |

Seed == standalone full build: max|diff| = 0.0. Unit test
`tests/unit/test_excitation_coeff_incremental.py` 7/7. Middleware Python + PianoidBasic wheel —
**no CUDA rebuild**.

## Notes / out of scope

- **Speed routing correction:** `hammer_speeds` is edited ONLY via `/excitation_energy` (full
  rebuild, now consolidated) — there is no silent `/set_parameter/mode` "no rebuild" speed-loss
  gap. Speed was *slow*, not *lost*.
- **Idle ~2 s floor:** when the engine is NOT cycling, `waitForParameterUpdate` on the
  `dev_hammer`/other uploads blocks ~2 s (timeout); this is separate from the coefficient path
  (the coeff upload is direct 0.23 ms) and only affects the idle state — in real playback the
  buffer swaps every 1.33 ms. The consolidation clears the >50 ms violation for the playing
  case; the idle floor is a separate follow-up.

Harnesses: `docs/development/diagnostics/dev-excenergy-latency-research.py` (the before
breakdown), `docs/development/diagnostics/dev-excenergy-consolidation-verify.py` (the after
per-kind correctness+latency gate).
