# dev-fpgaimport-7c4a — Import Fanera_6 FPGA archive into a new preset

**Date:** 2026-06-11
**Task:** Import the FPGA archive `Fanera_6` into a NEW preset based on
`Belarus_196modesC`, applying ONE transform — exp_all volume slot made
all-positive ("change sign for negative values"). Generated artifact only;
not committed.
**Predecessor:** `explore-fpga-e0f4-2026-06-11.md` (format-mapping investigation —
confirmed Fanera_6 is byte-for-byte schema-compatible with the prior `Bl_Apr_19`
dump; only the data differs, with `ind_vol` ~3× hotter).

## Docs-first

- `docs/modules/pianoid-middleware/OVERVIEW.md` → **Loading FPGA presets** —
  canonical recipe: load base preset, instantiate Pianoid, call
  `load_excitation_from_fpga_preset(main_volume=1.0, volume_sign_handling="abs")`,
  `save_preset()`. Loader touches **excitation only**; deck/modes/sound-channels
  stay intact. Deck import is a *separate optional* `load_deck_from_txt()` call.
- `PianoidCore/pianoid_middleware/pianoid.py` — `load_excitation_from_fpga_preset`
  (decode + sign handling) and `load_deck_from_txt`.
- `PianoidCore/tools/generate_belarus_fpga_preset.py` — reference recipe.
- Reference output: `presets/Belarus_8band_196modes_FPGAexc.json`.

## High-stakes data-semantics resolution — exp_all sign transform

`exp_all` decodes to shape `(5 levels, 88 pitches, 4 params[mu, sigma, volume,
shift], 5 gauss)`. Measured the Fanera_6 values directly (canonical venv,
`read_excitations_from_txt`):

| slot | name | min | max | negatives |
|---|---|---|---|---|
| 0 | mu    | 0.184  | 3.824  | 0 / 2200 |
| 1 | sigma | 0.0455 | 0.468  | 0 / 2200 |
| 2 | **volume** | **-0.556** | 0.420 | **440 / 2200** |
| 3 | shift | 0 | 0 | 0 / 2200 |

**Only slot 2 (volume) goes negative**, and within volume **only Gauss
component index 2** carries the negatives (all 440 = 5×88×1, range
[-0.556, 0]). mu/sigma/shift are never negative.

→ The user's requirement "in exp_all change sign for negative values, should be
all positive" maps **exactly** to `volume_sign_handling="abs"`, which applies
`np.abs()` to the volume slot only (after main_volume·ind_vol; both positive, so
abs-after = abs-before sign-wise). This flips the negative Gauss-2 volumes
positive WITHOUT touching mu/sigma/shift — no corruption, no mis-target. This is
also the recipe's documented default for framework-native presets. No ambiguity.

## Build

Single Pianoid instance (feedback rule). Base = `presets/Belarus_196modesC`
(num_modes=196, num_channels=4, num_strings=224; piano pitches 23..106, so FPGA
21/22/107/108 skipped). Imported Fanera_6 excitation via
`load_excitation_from_fpga_preset(main_volume=1.0, apply_ind_vol=True,
apply_ind_mult=True, volume_sign_handling="abs")`. Saved to:

**`PianoidCore/pianoid_middleware/presets/Belarus_196modesC_Fanera6exc.json`**
(uncommitted, generated artifact).

84 pitches wired; 21/22/107/108 skipped (not in base). Post-transform excitation
volume slot: **zero negatives** (asserted), global range [0, 13.72], grand-median
|vol| 0.131 (FPGA-native units).

## Verification (Audio Verification Rule)

Direct offline `runOfflinePlayback` render, single instance, audio_off; pitches
40/60/76/88, vel 100, 300ms+200ms decay. Comparison render of base
`Belarus_196modesC` in a SEPARATE process (no double-instantiation).

| preset | max-peak | mean-rms | NaN | clip cells | empty? |
|---|---|---|---|---|---|
| Belarus_196modesC (base) | 75.4 | 4.72 | 0 | 0 | no |
| Belarus_196modesC_Fanera6exc | 2.18e-9 | 1.51e-10 | 0 | 0 | no |

- **Non-silent, sane** — all 4 pitches sound, no NaN, no clip blow-out.
- **Shapes/modes match the base** (num_modes 196, num_strings 224, num_channels 4).
- **Loudness:** Fanera6 renders ~3.4e10× quieter than base because it is in
  FPGA-native volume units (~0.13) while the hand-tuned base is in CUDA-amplitude
  units (~1e8). This is the **documented intended behavior** of `main_volume=1.0`:
  the reference `Belarus_8band_196modes_FPGAexc.json` is likewise FPGA-native
  (grand-median |vol| 0.037 — my Fanera6 is ~3.5× louder in those units, matching
  explore-fpga's "ind_vol 3× hotter" note). Downstream `set_volume`/CUDA scaling
  supplies loudness; the user will need to raise volume substantially (or
  regenerate with higher `main_volume` ≈ 1e9–8e9) for direct audibility.

## Open caveat — deck NOT imported (deliberate)

The task mentioned importing deck (`load_deck_from_txt`) as well. **The documented
loader is incompatible with this dump:** `Ci_coef_cos.txt`/`Ci_coef_str.txt` are
45056 lines (= 176×256), but `load_deck_from_txt` hardcodes `.reshape(176, 128)`
(needs 22528) → it raises `cannot reshape array of size 45056 into shape
(176,128)`. The prior `Bl_Apr_19` dump has the SAME 45056-line layout, and the
reference recipe `generate_belarus_fpga_preset.py` imports **excitation only**,
deliberately keeping base deck/modes intact. Importing deck here would require a
`/dev` code change to the loader's reshape (256-wide → `[:88,:196]`), which is out
of scope for "run the documented loader." → **Followed the canonical recipe:
excitation-only import, base deck preserved.** Flagged for the user to decide.

## Regeneration — fix silence (main_volume tuning, 2026-06-11)

User reported the first preset (main_volume=1.0) is SILENT — exactly the
FPGA-native-units loudness flagged above (peak 2.18e-9 = inaudible). User
confirmed excitation-only (no deck). Regenerated SAME name, same abs transform,
tuning `main_volume` for an AUDIBLE render loudness-comparable to base.

**Linearity confirmed:** render peak scales exactly linearly with main_volume
(mv=1.0 → peak 2.18e-9; mv=1e9 → peak 2.18, i.e. ×1e9). Matched to base:
- match max-peak (base 75.4): mv ≈ 1e9·75.4/2.18 ≈ 3.46e10
- match mean-rms (base 4.72): mv ≈ 1e9·4.72/0.151 ≈ 3.12e10
- chose **main_volume = 3.3e10** (covers both).

**Final render @ main_volume=3.3e10 (volume_sign_handling="abs", ind_vol+ind_mult on):**

| | max-peak | mean-rms | NaN/Inf | clip |
|---|---|---|---|---|
| Base Belarus_196modesC | 75.4 | 4.72 | 0 | 0 |
| Fanera6 @ mv=3.3e10 | 71.8 | 4.99 | 0 | 0 |

Within 5–6% of base on both peak and rms — audible and loudness-comparable.
Per-pitch: pitch 60 hottest (peak 71.8), pitch 40 quietest (7.2) — the
Fanera_6 "3× hotter ind_vol" spread; loudest pitch still below base peak, no
clip, no NaN/Inf. exp_all still all-positive (zero negatives, asserted at save).
Preset overwritten at the same path `Belarus_196modesC_Fanera6exc.json`
(uncommitted). Deck still NOT imported (excitation-only, base deck preserved).

## Constraints honored

Canonical venv `PianoidCore/.venv`. Docs-first. Single Pianoid instance per
process. Temp-extract only (`%TEMP%/fpga_fanera6_import/`, never the repo). Live
stack (dev-mwfix) untouched — no ports used, direct-Python only. No code edits.
Preset left uncommitted.
