# FPGA Preset Excitation Loader — schema discovery and proposal

**Date:** 2026-05-17
**Status:** IMPLEMENTED — `Pianoid.load_excitation_from_fpga_preset()` in `PianoidCore/pianoid_middleware/pianoid.py` (+ `tests/unit/test_fpga_excitation_loader.py`, `tools/generate_belarus_fpga_preset.py`). Archived 2026-06-05.
in `PianoidCore/pianoid_middleware/pianoid.py` (dev-fpga-exc Phase 1, 2026-05-06).
**Revised after slot-mapping audit (dev-fpga-exc Phase 2, 2026-05-06)** —
see [Revision after slot-mapping audit](#revision-after-slot-mapping-audit-2026-05-06)
section at the bottom for corrected findings.
Generated preset: `PianoidCore/pianoid_middleware/presets/Belarus_8band_196modes_FPGAexc.json`
(`main_volume = 1.0`, `volume_sign_handling = "abs"` — FPGA-native scale,
all-positive volumes).
Production loader tests: `PianoidCore/tests/unit/test_fpga_excitation_loader.py` (21 tests).
Preset generation recipe: `PianoidCore/tools/generate_belarus_fpga_preset.py`.
See **Loading FPGA presets** in [middleware OVERVIEW](../modules/pianoid-middleware/OVERVIEW.md#loading-fpga-presets).
**Author:** orchestrator sub-agent (sub-agent of `/analyse`)
**Sample preset:** `PresetsFromFpga/Bl_Apr_19/`
**Prototype loader:** `PianoidCore/tools/load_fpga_excitation_proto.py` (research-only)

---

## Executive summary

The FPGA preset dump contains the per-pitch excitation source in
`exp_all.txt`, not in `Force_vozb.txt` as the user-provided spec stated.
`exp_all.txt` is exactly the user-described "groups of 15 (3×5 = 3 params ×
5 gauss), 5 levels, 88 pitches" layout (`5×88×3×5 = 6600` values, file is
6600 lines).  The "3 params" along the innermost axis are `(mu_encoded,
sigma_ms, volume)` with mu fixed-point-encoded as
`raw = mu_ms^-2 * 2^21` and decoded by the existing
`Pianoid.read_excitations_from_txt` transform `1.28 / sqrt(raw)`.

`Force_vozb.txt` (10240 lines) is **not** a parameter source -- it is a
debug capture of the **rendered force waveform** for only **8 pitches at
2 velocity levels** (`f` and `ff`), with layout
`(5 levels × 8 pitch_slots × 256 samples)`.  Most of the file is zero
padding (only 2350 of 10240 lines are non-zero).  It is useful only as a
cross-validation reference for the renderer.

`ind_vol_*.txt` and `ind_mult_*.txt` are **per-pitch per-level scalar
coefficients** (`88×5` after slicing).  Their layout is one file per
velocity level, and within each file one value per pitch (88 piano keys
A0–C8, MIDI 21–108).  `ind_vol` is the per-(pitch,level) **volume
multiplier** (FPGA analogue of `ExcitationParameters.volume_coefficients`).
`ind_mult` is the per-(pitch,level) **time-scale coefficient** consumed
via `ExcitationParameters.set_time_scale` (divides mu and sigma).

Most of this machinery already exists in
`PianoidBasic/Pianoid/StringExcitation.py::read_excitations_from_txt`.
What is missing is a `Pianoid` instance method analogous to
`load_deck_from_txt` that wires the decoded excitation matrices into the
live `StringMap`, plus an FPGA-preset-aware `load_preset` entry point.
The proposed loader (`load_excitation_from_fpga_preset`) is sketched in
the prototype.

---

## File-by-file schema discovery

All paths are relative to `PresetsFromFpga/Bl_Apr_19/`.

### 1. `exp_all.txt` — canonical per-pitch gauss parameters

| Field | Value |
|---|---|
| File length | 6600 lines (one float per line) |
| Total = `5 × 88 × 3 × 5` | 6600 ✓ |
| Decoded shape | `(5_levels, 88_pitches, 3_raw_params, 5_gauss)` |
| Level axis | `[pp, p, mf, f, ff]` (legacy 5-level convention; framework auto-migrates to 6 levels via `_migrate_5_to_6_levels`) |
| Pitch axis | piano key index `0..87` corresponding to MIDI `21..108` (A0..C8) |
| Raw param axis | `[0 = mu_encoded, 1 = sigma_ms, 2 = volume]` |
| Gauss axis | 5 Gaussian components (per `NUM_GAUSS` in `constants.py`) |
| Reshape order | C-order (row-major); file iterated `for level: for pitch: for param: for gauss` |

#### mu encoding and decode

Raw slot 0 stores `raw = mu_ms^-2 × 2^21` as a fixed-point inverse-square.
The decode pipeline (lifted verbatim from
`read_excitations_from_txt`):

```python
raw[raw == 0] = 1                    # guard against div-by-zero
raw = raw / (2 * 1_048_576)          # divide out the 2^21 fixed-point scale
mu_ms = (raw * 2) ** -0.5 / 800      # collapses to 1.28 / sqrt(original raw)
```

Empirical decoded range across the whole Bl_Apr_19 preset:
`mu_ms ∈ [0.184, 3.824]` — fits the 0–8 ms excitation window.

#### sigma_ms (raw slot 1) and volume (raw slot 2)

Both are stored directly in physical units (no transform):

* `sigma_ms ∈ [0.046, 0.488]` ms — matches Gauss width range in
  `BaselineBelorus1.json` (0.054–0.97 ms).
* `volume ∈ [-0.556, 0.420]` — dimensionless in FPGA convention.
  Negative values are allowed; the framework's
  `ExcitationCurve.get_curve(cut_negative=True)` zero-clips the **post-sum**
  curve, so per-component negatives shape the final pulse rather than
  silencing it.

The framework's `ExcitationParameters.levels_matrix` expects param-axis-2
= `(mu, sigma, volume, shift)` with shift=0 for FPGA presets.  The
decoded mu/sigma/volume map slot-for-slot; the shift slot is appended as
zeros (matches the existing `np.pad(..., (0,1))` step in the reference
loader).

### 2. `Force_vozb.txt` — rendered force WAVEFORM (debug capture, not parameters)

| Field | Value |
|---|---|
| File length | 10240 lines |
| Decoded shape | `(5_levels, 8_pitch_slots, 256_samples_per_slot)` |
| Total = `5 × 8 × 256` | 10240 ✓ |
| Non-zero coverage | 14 of 40 (level, pitch) cells; **only levels 3 (f) and 4 (ff)**; pitch_slots 0–7 for level 3, pitch_slots 0,1,3,4,6,7 for level 4 |
| Per-cell non-zero length | 173 samples (level 3), 161 samples (level 4) — i.e. the rendered excitation window |

Block-start mapping (1-indexed file rows):

```
level 3: 6187, 6443, 6699, 6955, 7211, 7467, 7723, 7979       (slots 24..31, stride 256)
level 4: 8241, 8497, 9009, 9265, 9777, 10033                   (slots 32, 33, 35, 36, 38, 39 -- gaps)
```

Stride 256 between successive non-zero blocks, with the first block at
slot 24 (= 3 × 8) means the file is `level-major, then pitch-slot, then
sample`; levels 0–2 (pp, p, mf) are entirely zero in this dump.

**This is a diagnostic snapshot, not a per-pitch parameter file.**  Only
8 pitches are present (not 88), and only at high velocities.  The
user-supplied spec ("organized by groups of 15, 5 levels × 3 params, 88
pitches covered") does **not** apply to `Force_vozb.txt`.  That spec
matches `exp_all.txt` exactly.

Recommended use: cross-validate the Python-rendered Gauss curve against
the FPGA's actual output for the 8 captured pitches at f / ff.
Mismatches would indicate a bug in either the decode pipeline or the
framework's `GaussCurve.get_gauss` math.

### 3. `ind_vol_0..4.txt` — per-pitch per-level volume multiplier

| Field | Value |
|---|---|
| File count | 5 (one per velocity level: `_0=pp`, `_1=p`, `_2=mf`, `_3=f`, `_4=ff`) |
| Lines per file | 128 |
| Non-zero rows | 1..89 (rows 90..128 are zero padding to the FPGA's 128-pitch addressing) |
| Loader slice | `[:88, :]` after transpose → shape `(88_pitches, 5_levels)` |
| Axis ordering | **`[pitch_idx, level_idx]`** (pitch_idx 0 = MIDI 21 = A0) |
| Value range (Bl_Apr_19) | `[0.024, 9.999]`, mean ≈ 1.21 |

Per the spec: "two ind_vol (volume multiplication) per pitch per level or
per level per pitch and in the same fashion".  Answer: **per pitch per
level**, with one file per level and one row per pitch within each file.

Likely semantics: multiplied into the framework's
`ExcitationParameters.levels_matrix[level, 2 (volume), :]` slot during
preset load.  This matches the role of the framework's
`volume_coefficients` attribute (`pack_gauss_params(volume_coefficients=
True)` multiplies the volume row before extrapolation).

### 4. `ind_mult_0..4.txt` — per-pitch per-level time-scale coefficient

| Field | Value |
|---|---|
| File count | 5 (one per velocity level) |
| Lines per file | 88 (exactly one per piano key, no padding) |
| Loader slice | direct after transpose → shape `(88_pitches, 5_levels)` |
| Axis ordering | **`[pitch_idx, level_idx]`** |
| Value range (Bl_Apr_19) | `[0.580, 2.925]`, mean ≈ 1.03 |

Likely semantics: passed to `ExcitationParameters.set_time_scale`, which
divides both mu and sigma by the coefficient (i.e. `>1` compresses the
pulse, `<1` stretches it).  The Bl_Apr_19 range `[0.58, 2.92]` produces
roughly ±50% timing scaling around 1.0.

The fact that `ind_vol` is 128 rows long (FPGA-addressed) but `ind_mult`
is 88 rows long (piano-key-only) is a structural quirk worth flagging in
docs.  The proposed loader normalises both to `(88, 5)` via the existing
`[:88, :]` slice in PianoidBasic.

---

## Cross-check vs Belarus preset

`BaselineBelorus1.json` (a previously-imported preset, presumably from an
older FPGA dump) was decoded for MIDI pitch 60 at level 127 (ff).  The
FPGA `exp_all.txt` for the same MIDI 60 / level 4 (ff) cell was decoded
via the proposed transform.

| Parameter | Gauss idx | Belarus (BaselineBelorus1.json) | FPGA (Bl_Apr_19/exp_all.txt) |
|---|---|---|---|
| mu_ms | 0 | 6.14 | 0.93 |
| mu_ms | 1 | 1.149 | 2.94 |
| mu_ms | 2 | 0.505 | 0.85 |
| mu_ms | 3 | 2.34 | 2.98 |
| mu_ms | 4 | 1.149 | 2.94 |
| sigma_ms | 0 | 0.168 | 0.327 |
| sigma_ms | 1 | 0.054 | 0.127 |
| sigma_ms | 2 | 0.071 | 0.079 |
| sigma_ms | 3 | 0.969 | 0.214 |
| sigma_ms | 4 | 0.054 | 0.127 |
| volume | 0 | 1.03e8 | 0.092 |
| volume | 1 | 0 | 0.400 |
| volume | 2 | 2.08e8 | -0.340 |
| volume | 3 | 1.14e9 | 0.217 |
| volume | 4 | 0 | 0.400 |

Observations:

1. **mu and sigma magnitudes match within an order of magnitude** -- both
   live in the 0–8 ms window for mu and the 0.05–1 ms range for sigma.
   Confirms the decode pipeline (mu = 1.28 / sqrt(raw)) yields physical
   milliseconds, and the slot ordering `(mu, sigma, volume)` is correct.
2. **Per-gauss-component shapes differ between the two presets.**
   Belarus has only 3 active gauss components (volumes for idx 1 and 4
   are zero); FPGA Bl_Apr_19 uses all 5 with varying volumes (including
   negatives).  This is expected -- the two presets describe two
   different physical pianos.
3. **Volume scale differs by ~8 orders of magnitude.**  FPGA volumes are
   in `[-0.6, 0.4]`; Belarus volumes are in `[1e7, 1e9]`.  See "Open
   questions" below.
4. **Render sanity check.**  Summing the 5 Gauss components for the FPGA
   pitch-60-ff cell produces a curve that peaks at t ≈ 2.94 ms with
   amplitude ≈ 0.84.  Belarus's curve for the same pitch peaks at
   t ≈ 2.33 ms with amplitude ≈ 1.14e9.  Both shapes look like a
   plausible hammer-strike pulse; only the absolute scale differs.

Verdict: **the FPGA→framework axis interpretation is confirmed for
mu, sigma, and the gauss-component ordering**.  The volume axis is
correctly identified but its absolute scale needs calibration (see Open
question 1).

---

## Proposed loader

### Public surface

```python
def load_excitation_from_fpga_preset(
    preset_dir: str | Path,
    apply_ind_vol: bool = True,
    apply_ind_mult: bool = True,
) -> dict[int, np.ndarray]:
    """Build per-pitch (5, 4, 5) parameter matrices for ExcitationParameters.

    Returns dict[midi_pitch -> levels_matrix slice] with midi_pitch in
    21..108 (A0..C8).  Each value is shape (5, 4, 5) and can be passed
    directly to ExcitationParameters.load_from_matrix(), which will
    auto-migrate 5 levels to 6 and extrapolate to 128.
    """
```

### Algorithm

1. **Read `exp_all.txt`** → reshape to `(5, 88, 3, 5)`.
2. **Decode mu slot** via `1.28 / sqrt(raw)` with a `raw==0 → 1` guard.
3. **Append zero shift slot** along the param axis → `(5, 88, 4, 5)`.
4. **Read `ind_vol_0..4.txt`** via the existing `read_index` helper →
   slice to `(88, 5)`.
5. **Read `ind_mult_0..4.txt`** the same way.
6. If `apply_ind_vol`: multiply the volume slot (axis-2 idx 2) by
   `ind_vol[pitch, level]`.  Broadcast as `[level, pitch, 1, 1]`.
7. If `apply_ind_mult`: divide the mu and sigma slots by
   `ind_mult[pitch, level]`.  Mirrors `set_time_scale` semantics.
8. Slice per pitch (`exp[:, piano_idx, :, :]`) and emit a dict keyed by
   MIDI pitch (`piano_idx + 21`).

### Wiring into Pianoid

To actually load an FPGA preset end-to-end, an instance method
analogous to `Pianoid.load_deck_from_txt` is needed:

```python
def load_excitation_from_fpga(self, preset_path: str) -> None:
    """Mirror of load_deck_from_txt for FPGA-format excitation files."""
    per_pitch = load_excitation_from_fpga_preset(preset_path)
    for midi_pitch, mat in per_pitch.items():
        if midi_pitch not in self.sm.pitches:
            continue                                          # skip unmapped
        self.sm.pitches[midi_pitch].excitation.load_parameters(mat)
```

This is **out of scope for this proposal** (would require live
integration with `StringMap`, double-buffer push, and the calibration
path).  The proposal stops at producing a validated per-pitch dict from
the FPGA files.

### Prototype script

`PianoidCore/tools/load_fpga_excitation_proto.py` implements all
read-side functions plus a CLI:

```bash
python PianoidCore/tools/load_fpga_excitation_proto.py \
    D:/repos/PianoidInstall/PresetsFromFpga/Bl_Apr_19
```

prints a schema dump of every file with shape, range, and zero-padding
notes.  No imports from `Pianoid` -- pure numpy.

---

## Open questions

1. **Absolute volume scale.** RESOLVED (dev-fpga-exc, 2026-05-06): the
   production loader exposes a `main_volume` scalar argument that the
   caller picks to land FPGA volumes in the same order of magnitude as
   the host preset. For the Belarus family, `main_volume = 8.35e9`
   makes the per-pitch median |volume| match Belarus's median within
   3%. The "where does the extra scale come from" mystery remains
   theoretically open — Belarus was likely calibrated by hand under an
   older import path — but practically resolved by user-tunable
   calibration at load time.
   FPGA volumes are in `[-0.6, 0.4]`; Belarus
   preset volumes (presumably derived from a previous FPGA import) are
   in `[1e7, 1e9]`.  Even after multiplying by `ind_vol` (max ≈ 10), we
   only reach `~4` -- 7 orders of magnitude below Belarus.  Where does
   the extra scale come from?  Hypotheses:
   - A fixed calibration multiplier applied in the framework's CUDA
     kernel (search for `excitation_factor`, `volume_coefficient`, and
     `unit_volume` in the C++ path).
   - The framework's `set_time_scale` or `set_volume` chain applies a
     per-string mass / hammer-radius rescale that compounds.
   - Belarus was imported by a different loader that hand-tuned the
     scale; the canonical FPGA-volume → Pianoid-volume conversion is
     undocumented.
2. **Dummy / zero-volume gauss components.**  FPGA gauss components with
   `volume = 0` are still loaded with non-zero mu/sigma.  The framework
   silently includes them in the sum (they contribute zero anyway).
   Worth a comment in the loader.
3. **Extra rows in `ind_vol_*.txt`.** RESOLVED by decision (dev-fpga-exc,
   2026-05-06): the production loader silently drops 1-indexed file row
   89 (0-indexed row 88) via the existing `[:88, :]` slice, treating it
   as an FPGA off-by-one artifact. Unit test
   `TestIndVolRow89Drop::test_sliced_ind_vol_drops_row_88` asserts the
   row-88 value never leaks into the wired data.
   Row 89 of Bl_Apr_19/ind_vol_0.txt
   is `0.036367` -- non-zero but past the piano-key boundary.  Rows 90
   onwards are zero.
4. **Level→velocity-band mapping.**  FPGA stores 5 levels
   `[pp, p, mf, f, ff]` ≈ MIDI velocities `[20, 50, 70, 100, 125]` (the
   conventional musical-dynamics-to-MIDI table).  The framework migrates
   5→6 by inserting a pp row at index 1 equal to 0.3 × the p row -- but
   this assumes the FPGA's `pp` is at index 0.  Confirm the FPGA level
   ordering matches the user's stated `[pp, p, mf, f, ff]`.
5. **Force_vozb pitch_slot identity.**  The 8 pitch_slots in
   `Force_vozb.txt` are presumably a contiguous run of MIDI pitches
   centred on some test note.  Identify which 8 pitches by comparing
   the rendered curves against Python-rendered curves from
   `exp_all.txt` for plausible candidates (likely middle-C octave
   pitches 55–62 or A4 octave 65–72).  Needed only if Force_vozb is
   used for renderer validation.

---

## Appendix: reference values from prototype dump

Output of running the prototype against Bl_Apr_19:

```
exp_all.txt        : shape (5, 88, 4, 5), dtype float64
  axis: [level=5, pitch=88, param=4 (mu,sigma,vol,shift), gauss=5]
  mu_ms     range: [0.1844, 3.8245]
  sigma_ms  range: [0.0455, 0.4883]
  volume    range: [-0.5562, 0.4199]

ind_vol_0..4.txt   : shape (88, 5)
  axis: [pitch=88, level=5 (pp,p,mf,f,ff)]
  value range: [0.0239, 9.9988], mean 1.2083

ind_mult_0..4.txt  : shape (88, 5)
  axis: [pitch=88, level=5 (pp,p,mf,f,ff)]
  value range: [0.5802, 2.9248], mean 1.0303

Force_vozb.txt     : shape (5, 8, 256), non-zero levels = [3, 4]
  axis: [level=5, pitch_slot=8, sample=256]  (DEBUG CAPTURE)
  -- only 8 of 88 pitches captured, only levels [3, 4] populated
  -- this is a rendered force WAVEFORM, NOT per-pitch parameters.
     Use exp_all.txt for the canonical excitation source.
```

---

## Revision after slot-mapping audit (2026-05-06)

The Phase 1 implementation landed `main_volume = 8.35e9` (picked to match
the `Belarus_8band_196modes.json` median |volume| of 3.18e8) with all
slot-2 negatives passed through as kernel-side signed volumes. Two
user concerns prompted a re-audit:

1. "Volume cannot be negative" — physically true for the framework's
   hand-tuned presets, but the FPGA dump's slot 2 is structurally signed.
2. "Most probably parameters are mixed up" — suspicion that the slot
   identification `(slot 0 = mu_enc, slot 1 = sigma, slot 2 = volume)`
   was wrong.

### Findings from the audit

**Slot mapping was correct, but the per-component clipping story was
wrong, and the "calibrate to Belarus" story was a coincidence.**

1. **Slot identification is correct (high confidence).**
   `slot 0 = mu_encoded` decoded via `1.28/sqrt(raw)` → mu_ms in
   [0.18, 3.83] (all positive). `slot 1 = sigma` direct → [0.045, 0.488]
   ms (all positive, matches plausible Gauss-width range). `slot 2 = vol`
   signed → [-0.556, 0.420]. No axis permutation produces a cleaner
   structure.

2. **Negatives in slot 2 are structural, not random.** 100% of negative
   slot-2 cells are concentrated in Gauss component index 2 (Gauss 2's
   volume is always negative across all 440 (level, pitch) cells). Gauss
   0 is mostly zero (88% of cells). Gauss 1 and Gauss 4 are identical
   in 97.3% of cells (a duplicate — see "Known quirk: Gauss 1 ≡ Gauss 4"
   in middleware OVERVIEW).

3. **CUDA kernel handles signed g_vol natively as subtractive
   contribution.** Inspected `pianoid_cuda/gaussTest.cu` lines 83-87:
   `s2exp = max(exp(...) - g_shift, 0); result += s2exp * g_vol;`
   The clip is at the *shift* step, not the *volume* step. A negative
   `g_vol` produces a subtractive Gauss contribution that is then summed
   into the result without clipping. The PianoidBasic Python preview's
   `cut_negative=True` flag clips per-component (giving silenced
   components for negative volume), but **the CUDA path does not** — so
   the rendered sound is different from the Python preview when signs
   matter.

4. **Force_vozb is NOT a per-pitch reconstruction reference.** The
   proposal claimed it held rendered waveforms for 8 different pitches;
   in fact all 8 slots at L=3 are *identical* (the same single-Gauss bell)
   and L=4 has 6 identical + 2 zero slots. Each waveform is a perfect
   single Gaussian (curve_fit error ~5e-7 of peak):
   - L=3: mu=4.000 ms, sigma=0.562 ms, vol=0.05
   - L=4: mu=4.013 ms, sigma=0.424 ms, vol=0.305
   It is a fixed reference test signal, not a reconstruction of
   exp_all parameters. Slot-mapping cannot be validated against it.

5. **Belarus is structurally different from FPGA (rejects the
   "calibrate to Belarus" frame).** Belarus pitch volumes are 100%
   non-negative, mu/sigma are *constant across all 84 pitches* (only
   1-2 unique values per gauss at L=127), and all 3 active gauss have
   identical per-pitch volume spread ratio (277.37x). Belarus is a
   hand-tuned preset with global mu/sigma + one per-pitch volume
   coefficient applied to 3 fixed-shape Gauss components. The FPGA dump
   has per-pitch varying mu/sigma — a fundamentally different model.
   "Median match at main_volume=8.35e9" was a coincidence, not
   structural correspondence. There is no canonical "calibrate to
   Belarus" constant.

### Implementation changes (dev-fpga-exc Phase 2 commit)

- **New parameter** `volume_sign_handling: str = "raw"` on
  `Pianoid.load_excitation_from_fpga_preset`. Accepts `"raw"` (default,
  kernel-faithful subtractive Gauss), `"abs"` (forces additive Gauss for
  framework-native presets), `"clip"` (silences negative components).
  Invalid mode strings raise `ValueError`.

- **Loader default `main_volume` reverted to `1.0`** (FPGA-native
  units). The "calibrate to Belarus" target was rejected as meaningless.
  Downstream `set_volume` / CUDA-side scaling handles loudness.

- **Generated preset regenerated** with `main_volume = 1.0` and
  `volume_sign_handling = "abs"`. The resulting per-pitch |volume|
  median is 3.69e-2, range [1.23e-2, 3.19e0] — FPGA-native scale
  preserved, all-positive. This is the user-visible new file at
  `presets/Belarus_8band_196modes_FPGAexc.json`.

- **Test count**: 21 (was 15 in Phase 1). Dropped the
  "Belarus-comparable order of magnitude" assertion as no longer
  meaningful; added 7 new tests for `volume_sign_handling` semantics
  (`raw` preserves negatives; `abs` produces all-positive matching
  `np.abs(raw)`; `clip` produces all-non-negative with zeros where raw
  was negative; `raw` is the default; `clip` differs from `abs`;
  invalid mode raises `ValueError`).

### Open questions that REMAIN open

- **Where do Belarus's per-pitch volume coefficients come from?** Not
  derivable from any current FPGA dump. Likely a separate
  hand-calibration pass on a different (older) FPGA export with a
  different convention. Out of scope for this proposal.

- **What does the FPGA renderer do with negative g_vol?** Likely
  consistent with the CUDA kernel's behavior (subtractive Gauss), but
  not confirmed by reading FPGA-side code. The `"raw"` mode trusts
  that this is intentional shaping; the `"abs"` mode bypasses the
  question entirely.

- **Are Gauss components 0 and 4 "spare" hardware slots?** Gauss 0
  is silent in 88% of cells and Gauss 4 == Gauss 1 in 97.3%. The
  effective active count is 3 (Gauss 1, 2, 3) — matching Belarus's
  active count. Whether this is intentional schema design or a
  hardware-layer leftover is unknown.
