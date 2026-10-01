# Local Review: dev-a480 FPGA → GPU preset converter (2026-09-30)

**Level:** local (`/review local`) · **Reviewer:** review sub-agent · **Mode:** read-only (no edits, commits or merges)

**Scope:** branch `feature/dev-a480-fpga-converter`
- PianoidBasic `D:/repos/wt-a480-basic` @ `c510202` vs `dev`: new `Pianoid/fpga_tables.py` (232 LOC) and `Pianoid/fpga_preset_converter.py` (479 LOC); legacy FPGA readers removed from `StringExcitation.py` and `Mode.py`.
- PianoidCore `D:/repos/wt-a480-core` @ `74ef0b2` vs `dev`: `pianoid.load_excitation_from_fpga_preset` now delegates to the converter; `load_deck_from_txt`, `tools/generate_belarus_fpga_preset.py` and `tests/unit/test_fpga_excitation_loader.py` removed; `tests/unit/test_fpga_preset_converter.py` added.
- Root `D:/repos/wt-a480-root` @ `f5d9323` vs `master`: docs and renders.

**Spec:** [FPGA → GPU preset port proposal](http://localhost:8001/proposals/fpga-to-gpu-preset-port-2026-09-30/), §11 (host "send all" formulas are authoritative). Host citations below are `QM:<line>` of `PresetsFromFpga/elyashev-2026-09-30/batch3/Pianoid_QM.c.utf8.txt`. I re-read each one.

**Verdict:** **PASS with follow-ups.** There are 0 Critical and 0 High findings, 6 Medium and 9 Low. The Medium items should be fixed or waived before merge. M1 is a real deviation from the send-all formulas.

**Tests:** `tests/unit/test_fpga_preset_converter.py` gives **26/26 passed** (canonical venv). The run used a scratch copy of the Basic worktree with relative imports (`module_convert.py -r`) plus the Core worktree middleware, all on `PYTHONPATH`. The installed wheel was not touched.

---

## 1. Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | `PianoidCore/pianoid_middleware/pianoid.py` | 3902 (was 4039, **−137**) | RED, known god object; this change **shrinks** it (win) |
| 2 | `PianoidBasic/Pianoid/StringExcitation.py` | 619 (was 699, −80) | YELLOW, already on the baseline list; shrinks |
| 3 | `PianoidBasic/Pianoid/fpga_preset_converter.py` | 479 (new) | Under 500, but **watch**: 21 lines below YELLOW and it holds 6 sub-concerns (see §4) |
| 4 | `PianoidBasic/Pianoid/Mode.py` | 470 (was 495, −25) | — |
| 5 | `PianoidCore/tests/unit/test_fpga_preset_converter.py` | 290 (new) | — |

`fpga_tables.py` has 232 LOC. No new file is over 500 and no RED file grows.

## 2. Architectural Consistency

- **Layer audit: PASS.**
  - FPGA-side semantics live in `fpga_tables`: pure functions, each citing its QM line.
  - The GPU-schema mapping lives in `fpga_preset_converter`. Both are in PianoidBasic (the domain model).
  - The middleware keeps only a thin overlay delegate.
- **Server audit: PASS.**
  - Only the main-server orchestrator (`pianoid.py`) is touched, and it imports only from `Pianoid.*`.
  - No REST route is added. No `modal_adapter` import.

### Authority Violations (P1)

| # | State | Owner | Violating Writer | Severity |
|---|-------|-------|------------------|----------|
| 1 | Engine velocity anchors `[0,5,31,63,95,127]` | `Pianoid/constants.py::LEVEL_INDICES` (mirrored by the C++ `interpolateBaseLevels`) | `fpga_preset_converter.GPU_ANCHORS` is a second literal copy (see M3) | Medium |

### Concern Violations (P2)

None. The `fpga_tables` / `fpga_preset_converter` split is clean: FPGA semantics on one side, GPU mapping on the other. The converter carries six sub-concerns in 479 lines: excitation, modes, deck, output, strings, and metadata/report/CLI. Any growth should split out the metadata/report/CLI part first.

## 3. Patch / Workaround Findings

- **TODO/FIXME/HACK count in scope:** 0 new. The removed `Mode.load_modes_from_txt` carried a "TODO: Function needs update!"; that TODO is now gone.
- **Silent exception handlers:** none.
- **Sleep-based synchronisation:** none.

| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| 1 | Fallback masks input (2.4) | `fpga_preset_converter.py:333-334, 299, 339` | Medium | See M6. Hard-coded fallbacks are used when template fields are missing: `hammer_mass` 0.008, `hammer_speeds` `[5.5]`, `hammer_sharpness` 0.5. Also `OUTPUT_SIGNAL_TO_ORDER.get(..., 1)` silently maps `output_signal="q"` to derivative order 1 |
| 2 | Leftover of removed feature (3.6) | `PianoidCore/pianoid_middleware/TunePreset.py:160` | Low | Commented-out `# pianoid.load_deck_from_txt()` refers to a method that no longer exists |
| 3 | Orphaned constant | `PianoidBasic/Pianoid/constants.py:140` `K_DEC` | Low | Its only consumer was the removed `Mode.load_modes_from_txt` |

---

## 4. Level-1 Findings

### 4.1 Formula check against the host send-all code (spec §11)

| Item | Converter | Host (verified) | Result |
|---|---|---|---|
| exp_all order | `(level, key, [e×5, d×5, a×5])` | `Save_fcnstr` QM:21986-22026; the loader follows the same order. `exp_e[gauss][level][key]` | ✅ |
| Only Gaussians 0..3 sent | `vol[4:] = 0` | `send_exp_coef` QM:25305: loop `k<4` over the **gauss** index (the first array index, per QM:4560-4564 and 7108-7176) | ✅ |
| e / d / a codes | `trunc(16777215·e)`, `trunc(2147000000·d)`, `trunc(2147000000·a)` | Locals at QM:25296-25297: `decimat_24 = 16777215.0`, `decim_32 = 2147000000`. `(int)` casts at QM:25311, 25336, 25359 | ✅ |
| ind_mult code | `trunc(65000·im)` | `send_udar_param` QM:13442 `decimat_23 = 65000.0`, QM:13481 | ✅ |
| ind_vol code | `trunc(v_L·ind_vol·8388607.5)`, `v_L = Strength_graph[5+L]` | QM:13542 | ✅ |
| Gaussian centre / σ in exciter steps | centre `d_code/im_code`; σ `(2²⁹/im_code)/√(2·e_code/2¹⁸)` | Derived again by hand from the RTL `a·exp(−(e/2¹⁸)((t−d)/2²⁹)²)` with `t = n·im_code`: 1/(2σ²) = (e/2¹⁸)(im/2²⁹)² | ✅ |
| **mu/sigma mapping** | **μ ← centre d, σ ← width e** (`decode_curve`) | Spec §11.1 | ✅ The old swap is fixed by construction, and `test_decode_curve_mu_is_centre_sigma_is_width` pins it |
| Mode W | `trunc(4f²·omega_ratio)/2³¹` (statistics only; `frequency` = `omega_coef` Hz) | `Send_Omega` QM:8909 (send-all form, with the 4) | ✅ |
| Mode D | `trunc(Q·q_ratio)/2³¹` (only with `host_q`) | QM:9660 | ✅ |
| Mode M | `trunc(Mass·2³¹/f²)/2³¹` | `send_mass` QM:338 | ✅ |
| FB | `−Gain_FB[1]` | `send_FB` QM:9534 (`-1.0*(float)val`) | ✅ |
| Output weights | `decka[ch][m]·out_vol·Ci_str_1_out[m]` | QM:27817 | ✅ |
| Ci layout | `reshape(-1,256)[:88]` | QM:4405-4440. Measured: rows 88..175 of the F_15 Ci files are exactly 0 | ✅ |
| PARAMETERS words | `(int)txt/2²⁴` for decr_op, disp, ttn | `Send_block_param` QM:254+ (`res = (int)data0[j]`) | ✅ |
| shteg | `trunc` (toward zero; −3.49 → −3) | `Send_block_param(4, shteg)`; `send_shteg(int nota, int shteg_pos)` takes an implicit `(int)` | ✅ |
| **Unison detune `dt`** | `tension_offset = dt/ttn` using the **raw float** `dt` | `send_nl` QM:17741+ sends `res = dt[j]` into an `int res`, so the FPGA gets **`(int)dt`** | ❌ See **M1** |
| Hammer cap | centre fraction `0.5−del`; half-width `√(1−ww²)` | `construct_molot` QM:394-400 uses a 1000-sample grid. It is resampled onto the allocation (`dx = 1000/Pitch[nota][k][0]`, `out_array[i] = tt[(int)(i·dx)]`), so the fractions are fractions of the **allocation** N | ✅ (see L1 for the ww ≥ 0 edge case) |

### 4.2 Units: hammer position is a fraction of string length

- **Correct.**
  - `hammer_position = (0.5 − del)·N/(N − tail)` is a ratio of the speaking length.
  - It is written unscaled, and `Hammer.unpack` multiplies it by `l_main` (`Hammer.py:128-129`). This matches `pack()` (`:113`).
  - `hammer_width` is in metres (`width_frac · geometry.length`, where `geometry.length` = `l_main()`, `StringState.py:50`).
  - `hammer_radius` is recomputed exactly as in `pack()`.
- **F_15 result:** positions 0.098–0.181, against a template value of 0.15.
- **Likely, not doc-cited:** that FPGA allocation index 0 and GPU x = 0 are the same (speaking) end. The tail is at the high end in both models (`Sdvig = start + N − shteg`), and the values are plausible.
- **Tail handling:** for a negative tail, `N − tail > N` (keys 52–87). This follows the host arithmetic and is flagged in the metadata.

### 4.3 Int truncations

- `np.trunc` matches C `(int)` (toward zero, also for negative amplitudes and shteg).
- Applied correctly to e, d, a, im, ind_vol, decr_op, disp, ttn, shteg, W, D and M.
- **Missing** for `dt` (M1).
- Levels are interpolated on float values before truncation, whereas the RTL interpolates per-layer codes (L2).

### 4.4 Stability default `--mode-mass host_max`

- **Correct as implemented:**
  - `k = mass_inv·(2πf)²`, scaled so max k = the template's median k.
  - The key semantics match `Mode.fit_params`: preset `"mass"` is `mass_inv` and `stiffness = mass_inv·(2πf)²` (`Mode.py:57-60, 127-129`).
  - `template_decrement` equals `Mode.py:147-148`.
- **What it really does:** the Belarus template has k = 0.1 for every mode. So `host_max` places **every** FPGA mode at or below the template coupling. Measured F_15 k range: 2.9e-5 to 0.1, so the weakest mode is about 3 400× weaker.
- The result is stable "by attenuation", which is consistent with the renders being 14–34 dB quieter. That is a sound safe default, but it is an unconfirmed absolute-scale choice and should be labelled as one (M2).

### 4.5 Removed functions: remaining callers

- **Searched:** `load_deck_from_txt`, `load_modes_from_txt`, `read_excitations_from_txt`, `read_index(`, `test_reading_from_preset`, `generate_belarus_fpga_preset`, `test_fpga_excitation_loader`, and the dropped kwargs `main_volume=`/`apply_ind_vol`/`apply_ind_mult` for `load_excitation_from_fpga_preset`.
- **Where:** all three worktrees plus `PianoidInstall/PianoidTunner` (`.py/.js/.jsx/.ipynb/.bat/.md`).
- **Code callers found:** none.
- **Hits that remain:**
  - `TunePreset.py:160`: a commented-out line (L-finding, §3 #2).
  - Archived logs (`docs/development/logs/archive/*`): historical, fine.
  - `main_volume=` hits are the unrelated `init_pianoid` volume API.
- `load_excitation_from_fpga_preset` now has **no production caller** (only the test). This was already true before the change (L8).
- **Main checkouts (`dev`) and the installed wheel:** the search over `PianoidInstall/PianoidCore`, `PianoidBasic` and `.venv/site-packages/Pianoid` finished later. It found only the definitions themselves (these are pre-merge `dev` copies) and no external callers.
- **Install note:** after the merge, the wheel must be rebuilt so the installed package drops the legacy readers and gains `fpga_tables` / `fpga_preset_converter`. The middleware delegate imports these modules from the installed `Pianoid` package.

### 4.6 Test meaningfulness

- **Good:**
  - `TestHostFormulas` uses hand-computed golden values for each send-all formula. Examples: the gauss centre 16.5153846 steps and σ 516.222; the `(int)` of 1e7·0.00015 = 1499; `ind_vol` code 30198987.
  - The hammer cap is checked by brute force against the actual host quadratic loop.
  - The mu/sigma swap is pinned.
  - The middleware overlay is tested to be the same code path.
- **Weak:** see M4.

### Findings (ranked)

| # | Principle | Severity | File:Line | Description |
|---|-----------|----------|-----------|-------------|
| **M1** | Spec fidelity (send-all) | **Medium** | `fpga_preset_converter.py:279`; `fpga_tables.py:199-203` | **`tension_offset` ignores the host `(int)dt` cast.** `send_nl` (QM:17741+, part of `send_all` via `Send_params`) sends `res = dt[j]` into an `int`, so the FPGA detune is `(int)dt` code units. The converter uses the raw float (`dt/ttn`). On F_15 (`dt` 1.12…865) `(int)dt/dt` has median 0.98 and **min 0.64**, so the detune is overstated by a median of about 2% and **up to 36%** on keys with small `dt`. This contradicts the spec §12 claim that host casts are applied everywhere. `unison_tensions` has the same gap. `test_strings_and_hammer` (`test_fpga_preset_converter.py:248`) pins the uncast formula. **Fix:** `trunc(dt)/trunc(ttn)`, and update the test. |
| **M2** | 2.4 No silent defaults / UNCONFIRMED labelling | **Medium** | `fpga_preset_converter.py:44, 180-195, 381-401` | The `mode_mass` absolute scale is not in `fpga_conversion.unknowns`, but it is as unconfirmed as the clocks (the FPGA→GPU force/displacement scale is unknown). `host_max` is stable because every mode's k is ≤ the template's (weakest 2.9e-5 vs 0.1), which also explains the −14…−34 dB level. **Fix:** list it in `unknowns`, and state the reason for the stability in the docs and docstring (attenuation relative to the template), not only "measured stable" on one preset. |
| **M3** | P1 / 2.1 SSOT | **Medium** | `fpga_preset_converter.py:31` | `GPU_ANCHORS = [0,5,31,63,95,127]` duplicates `constants.LEVEL_INDICES` (the owner, mirrored in C++ `interpolateBaseLevels`). The "stored == effective" guarantee silently breaks if the anchors ever change. **Fix:** import `LEVEL_INDICES`. |
| **M4** | Test meaningfulness | **Medium** | `test_fpga_preset_converter.py:215-253, 27-35` | (a) Several round-trip tests rebuild the expected value with the **same library functions** or the same formula as the code under test, so they only prove consistency. Examples: `test_excitation_anchor_equals_host_decode` (`gauss_timing_steps`/`level_interp`), `test_strings_and_hammer` (`dt/ttn`, `string_gamma`), `test_modes_and_deck` (`build_deck_rows`). (b) Not covered: `build_output_rows` scaling and column choice, `fit_loudness` with zero/NaN anchors, the `hammer_cap` ww ≥ 0 branch, `level_interp` with vint > 128, and the `dt` cast. (c) The default `FPGA_ROOT` is hard-coded to `D:/repos/PianoidInstall` (there is an env override). `REPO` is unused. |
| **M5** | Data integrity (decision needed) | **Medium** | `pianoid_middleware/presets/Belarus_8band_196modes_FPGAexc.json`, `Belarus_196modesC_Fanera6exc.json` | Both presets still carry the **swapped** decode and remain loadable with no marker in the file. Only the middleware OVERVIEW table documents this. **User decision:** regenerate, or tag/rename them. Regenerating Fanera6 loses a hand edit. |
| **M6** | 2.4 No silent defaults (S5) | **Medium** | `fpga_preset_converter.py:299, 333-334, 339` | Fallbacks: `hammer_mass` 0.008, `hammer_speeds` `[5.5]` (constants has `DEFAULT_HAMMER_SPEEDS`), and `hammer_sharpness` 0.5. `OUTPUT_SIGNAL_TO_ORDER.get(opts.output_signal, 1)` turns `--output-signal q` into order 1 (velocity) without a warning; the metadata only has a note. **Fix:** use constants, and raise or warn loudly for `q`. |
| L1 | Correctness (latent) | Low | `fpga_tables.py:206-215` | `hammer_cap` returns half-width `√(1−ww²)` for any ww. For ww ≥ 0 the host support is the whole allocation. F_15 has ww ∈ [−0.99993, −0.99812], so this is latent. Guard it or document it. |
| L2 | Spec fidelity (sub-LSB) | Low | `fpga_preset_converter.py:117-118`, `fpga_tables.py:90-102` | Layers are interpolated on float e/d/a/ind_mult and then truncated. The RTL interpolates per-layer integer codes. The difference is at most 1 LSB. |
| L3 | 3.3 Duplication | Low | `fpga_preset_converter.py:61-67, 291-300` | `_enc/_dec` copy `bytestream_encoding.encode_for_json/decode_from_json`. That module imports matplotlib/seaborn, which may justify the copy; if so, add a comment. `_apply_hammer` copies the `Hammer.pack` radius formula (two sites). |
| L4 | Hygiene | Low | `fpga_tables.py:73`; `fpga_preset_converter.py:378` | `open()` without a context manager (`load_pitch_file`, `_sha`). |
| L5 | 3.1 Lean / 3.6 | Low | `constants.py:140`; `TunePreset.py:160` | Orphaned `K_DEC`; commented-out `load_deck_from_txt()` call. |
| L6 | Naming / robustness | Low | `fpga_preset_converter.py:222, 354`; `fpga_tables.py:98-101` | `dropped_above_hz` holds the last **kept** mode (8913 Hz, and F_15 repeats 8913 Hz for modes 195+), not the first dropped one. `centre_ms_range` raises on an all-silent preset. `level_interp` raises IndexError for vint > 128 (F_15 max is 127). |
| L7 | Style | Low | `fpga_preset_converter.py:28` | `from fpga_tables import *`. This is the repo's package-import convention and `module_convert` handles it (verified), but an explicit import list would make the converter's dependencies clear. |
| L8 | 3.1 Lean | Low | `pianoid.py:3526` | `load_excitation_from_fpga_preset` has no production caller (test only). It was kept deliberately as a documented overlay; fine if intended. |
| L9 | Units (likely) | Low | `fpga_preset_converter.py:280-281` | The assumption that FPGA allocation index 0 and GPU x = 0 are the same end is plausible (tail at the high end in both; positions 0.10–0.18) but not doc-cited. Add one line to the spec or docstring. |

### Informational (flagged in metadata, not defects)

These are known engine gaps and open questions from spec §11.10. The converter reports them correctly in `preset["fpga_conversion"]`.

- **Exciter window:** at the default `exc_clocks = 512`, F_15 has `beyond_window_max` = 0.79 and median 0.14 of the force beyond the 7 ms window. Centres are 1.29–32.8 ms.
- **Velocity layers:** the 6-anchor engine interpolation departs from the FPGA layer interpolation by up to 2.47 ms in mu/sigma.
- **Loudness fit:** the rank-1 fit has a residual of 6.1 dB max and 1.27 dB rms.

### Summary

**PASS with follow-ups:** 15 findings, 0 Critical, 0 High, 6 Medium, 9 Low.

- **Checked and correct:** all send-all formulas except `dt`, the mu/sigma mapping, the hammer position ratio and width units, and the mode mass and decrement semantics.
- **Callers:** removed functions have no code callers left.
- **Code quality:** the new modules stay under the C4 thresholds, and the change shrinks the RED `pianoid.py` by 137 LOC.
- **Before merge:** fix M1 (it is a one-liner plus the test) and label the `mode_mass` scale (M2). M5 needs a user decision.
