# explore-fpga-e0f4 — Downloads FPGA archive map vs prior import format

**Date:** 2026-06-11
**Mode:** READ-ONLY investigation (no repo edits, no stack interaction, extract-to-temp only)
**Task:** Find the FPGA-parameter archive in Downloads, map its structure, cross-reference
against the documented/encoded prior FPGA-import format, assess doc-gap.

## Step 1 — Archive found

- **Target:** `C:\Users\astri\Downloads\Fanera_6.rar` ("Fanera" = Russian "plywood/veneer", consistent with soundboard measurement).
- Size 86,360 bytes, mtime 2026-06-11 12:18 (most recent archive in Downloads, dated today).
- Other FPGA-related Downloads archives: `Bl_Apr_19.rar` (May 17 — already extracted into the repo at `PresetsFromFpga/Bl_Apr_19/`), `PlyWoodSmallGrid.zip` (1.2 GB May 4 — name-related but a different/larger artifact, not opened).
- Extracted (read-only) to `%TEMP%\fpga_fanera6\Fanera_6\` via `C:\Program Files\7-Zip\7z.exe`. 51 files (Rar5).

## Step 2 — Structure

Folder of one-float-per-line `.txt` parameter files — **identical filename set to `PresetsFromFpga/Bl_Apr_19/`** except one extra `desktop.ini` (Windows folder-icon junk, not a parameter). 50 parameter `.txt` files.

Canonical excitation files (the ones the documented loader consumes), all matching documented line counts exactly:

| File | Lines (Fanera_6) | Expected | Decoded shape |
|---|---|---|---|
| `exp_all.txt` | 6600 | 6600 (=5×88×3×5) | `(5_levels, 88_pitches, 4_params[mu,sigma,vol,shift], 5_gauss)` |
| `ind_vol_0..4.txt` | 128 each | 128 | `(88_pitches, 5_levels)` after `[:88]` slice |
| `ind_mult_0..4.txt` | 88 each | 88 | `(88_pitches, 5_levels)` |
| `Force_vozb.txt` | 10240 | 10240 (=5×8×256) | `(5_levels, 8_pitch_slots, 256_samples)` — DEBUG waveform, not params |

`Notes_freqs.txt` starts at 27.5 Hz (A0 = MIDI 21), 92 lines — confirms 88-key A0..C8 coverage convention.

The many other `.txt` (Ci_coef_*, damping, decka_coeff, decr_*, disp, dt, FB, Gain_FB, impulse_resp_L/R, Mass, NL*, omega_coef, Q_coeff, Shape*, shteg, ttn*, velocity, width, etc.) are deck/modes/physics/IR dump files — the documented import path only consumes the excitation subset (exp_all + ind_vol + ind_mult); `load_deck_from_txt` separately reads `Ci_coef_cos/Ci_coef_str/Ci_str_out`.

## Step 3 — Prior import format (docs-first)

The format **IS documented** (not a gap):

- `docs/modules/pianoid-middleware/OVERVIEW.md` → **"Loading FPGA presets"** section (full semantics: schema, volume-sign handling, main_volume scale, skipped pitches, ind_vol row-88 quirk, Gauss1≡Gauss4 quirk, build recipe).
- `docs/proposals/archive/fpga-preset-excitation-loader-2026-05-17.md` — full file-by-file schema-discovery proposal + slot-mapping audit (status: IMPLEMENTED, archived 2026-06-05).
- Production loader: `Pianoid.load_excitation_from_fpga_preset(preset_dir, main_volume=1.0, apply_ind_vol, apply_ind_mult, volume_sign_handling="raw"|"abs"|"clip")` + `Pianoid.load_deck_from_txt()` in `PianoidCore/pianoid_middleware/pianoid.py`.
- Tests: `PianoidCore/tests/unit/test_fpga_excitation_loader.py` (21 tests). Build recipe: `PianoidCore/tools/generate_belarus_fpga_preset.py`. Reference output preset: `PianoidCore/pianoid_middleware/presets/Belarus_8band_196modes_FPGAexc.json`.
- Research prototype: `PianoidCore/tools/load_fpga_excitation_proto.py` (read-only schema dumper, pure numpy).

Decode pipeline: `exp_all` slot0=mu_encoded → `mu_ms = 1.28/sqrt(raw)`; slot1=sigma_ms direct; slot2=volume (signed, [-0.6,0.4] native); shift=0 appended. `ind_vol` multiplies the volume slot; `ind_mult` divides mu+sigma (time-scale). FPGA 5 levels [pp,p,mf,f,ff] auto-migrate 5→6 then extrapolate to 128.

## Step 4 — Mapping + discrepancies

Ran the documented prototype loader against Fanera_6 (canonical venv). **Decode succeeded, all shapes match.**

| Quantity | Bl_Apr_19 (prior) | Fanera_6 (new) | Verdict |
|---|---|---|---|
| File set / line counts | canonical | identical (+desktop.ini junk) | **No format drift** |
| `exp_all` mu_ms | [0.184, 3.824] | [0.184, 3.824] | match |
| `exp_all` sigma_ms | [0.046, 0.488] | [0.046, 0.468] | match (data) |
| `exp_all` volume | [-0.556, 0.420] | [-0.556, 0.420] | match |
| `ind_mult` | [0.580, 2.925] mean 1.03 | [0.580, 2.925] mean 1.03 | match |
| **`ind_vol`** | [0.024, 9.999] mean 1.21 | **[0.059, 48.33] mean 3.53** | **DATA differs — much higher/wider volume multipliers** |

**Conclusion:** Fanera_6 is the **same FPGA dump format** as the prior Bl_Apr_19 case — byte-for-byte schema-compatible. The documented `load_excitation_from_fpga_preset` + `load_deck_from_txt` import path applies unchanged. The only material difference is the **data**: `ind_vol` per-(pitch,level) volume multipliers are ~3x higher and reach 48 (vs ~10), so the imported excitation will be substantially louder before downstream scaling — worth flagging to the user when choosing `main_volume`/`volume_sign_handling`. No new/missing/renamed fields. **No doc gap** — prior info is adequately documented in the middleware OVERVIEW + archived proposal.

## Constraints honored

Read-only. Extracted only to system temp (`%TEMP%\fpga_fanera6`), never the repo trees. No code edits, no stack/port interaction. Docs-first for Step 3 (docs/index.md → middleware OVERVIEW → archived proposal → loader source). No sub-agents spawned.
