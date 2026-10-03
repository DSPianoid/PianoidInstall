# dev-f27f — tail damper (`damper_tail`) int truncation: evidence

Engine: PianoidCore `feature/dev-f27f-tail-damper` (off dev 097efb8) built `--heavy --both` into an ISOLATED venv
(`D:/repos/wt-f27f-core/.venv`); BEFORE = the unmodified dev source built the same way. Offline `runOfflinePlayback`,
one preset/config per process (`../dev-f27f-tail-damper-render.py`), 48 kHz, key held 1.0 s then released, 2.6 s.
Belarus family / BaselinePreset1 at 4 sub-steps, array 384; F15_Elyashev_array512 at its load params (16, 512).
Waveform diff = rms(after − before)/rms(before), channel 0 (`../dev-f27f-compare.py`); render-to-render noise of
identical configs: 1e-5…6e-4.

## 1. Root cause + semantics

`parameterKernel` (Kernels.cu): `dec = γ·dt + damper_string · dump_coeff · dt/dt_ref`, `int dump_coeff`; on the tail
`dump_coeff = physical_parameters[14]` = `int(damper_tail)`. History: the tail used a constant `DUMP_ON_TAIL = 127`
(3ad994e), replaced by slot 14 in 6e0182b with PianoidBasic default `damper_tail = 127` (b7e93d4, same day) ⇒
`damper_tail` is a **multiplier on `damper_string`** (like the main string's 18-step count). Stock presets store
`damper_tail == damper_string` (3e-6…1.1e-4) → truncated to 0. Fix: `real dump_coeff`; main keeps
`(real)(int)pow(...)`; tail reads `damper_tail` as a real.

## 2. BEFORE: is the tail damper dead? (`before/`)

| comparison (before engine) | A1 / C4 / C7 waveform diff | verdict |
|---|---|---|
| template stored vs stored (repeat) | 1.0e-4 / 2.8e-5 / 7e-6 | noise |
| template stored vs damper_tail ×1000 | 1.1e-4 / 2.9e-5 / 6e-6 | = noise → DEAD |
| template stored vs damper_tail 0 | 1.0e-4 / 3.0e-5 / 7e-6 | = noise → DEAD |
| BaselinePreset1 stored vs 0 | 2.5e-4 / 6.7e-5 / 1.4e-5 | DEAD |
| FPGAexc stored vs 0 | 1.4e-4 / 3.2e-5 / 7e-6 | DEAD |
| template stored vs damper_tail 127 (integer) | 6.1e-2 / 2.1e-1 / 4.5e-1 (C7 held decay −22.6 → −37.8 dB/s) | acts → multiplier |
| F15 stored vs 0 | 2.6e-2…1.1e-1 / 0.74…0.94 / 0.29…0.36 (C4 v110 release −127.9 → −42.1 dB/s) | acts |

## 3. Kernel coefficients (debug `getParameters`, `../dev-f27f-coeff-diff.py`)

| preset | values | changed | where |
|---|---|---|---|
| F15_Elyashev_array512 | 950 272 | **0 (bit-identical)** | — |
| template / BaselinePreset1 / FPGAexc | 688 128 | 2 818 | tail points only: c0/c1/c2/t1/c_u ≤ 1.8e-7 rel (1 ulp), dec2 ≤ 4.3e-3 rel |

## 4. BEFORE vs AFTER, stored presets (`before_after_table.md`)

| preset | note | v | RMS dB before/after | decay held dB/s b/a | decay after release dB/s b/a | pitch c b/a | wav diff all / release |
|---|---|---|---|---|---|---|---|
| Belarus_8band_196modes | A1 | 64 | -69.88 / -69.88 | -16.97 / -16.97 | -81.30 / -81.22 | -5.9 / -5.9 | 1.0e-04 / 2.3e-04 |
| Belarus_8band_196modes | A1 | 110 | -63.02 / -63.02 | -16.92 / -16.92 | -66.51 / -66.52 | -5.9 / -5.9 | 1.0e-04 / 2.7e-04 |
| Belarus_8band_196modes | C4 | 64 | -89.33 / -89.33 | -27.10 / -27.10 | -36.44 / -36.46 | -20.0 / -20.0 | 3.1e-05 / 2.0e-04 |
| Belarus_8band_196modes | C4 | 110 | -81.84 / -81.84 | -27.21 / -27.21 | -36.55 / -36.56 | -20.0 / -20.0 | 2.6e-05 / 1.2e-04 |
| Belarus_8band_196modes | C7 | 64 | -122.79 / -122.79 | -22.64 / -22.64 | -98.41 / -98.40 | -23.3 / -23.3 | 1.6e-04 / 1.6e-03 |
| Belarus_8band_196modes | C7 | 110 | -118.00 / -118.00 | -22.71 / -22.71 | -90.81 / -90.82 | -23.3 / -23.3 | 1.5e-04 / 1.5e-03 |
| BaselinePreset1 | A1 | 64 | -79.38 / -79.38 | -6.50 / -6.50 | -81.79 / -81.80 | +1.9 / +1.9 | 2.5e-04 / 4.2e-04 |
| BaselinePreset1 | A1 | 110 | -72.41 / -72.41 | -6.46 / -6.46 | -84.03 / -84.03 | +1.9 / +1.9 | 2.7e-04 / 3.7e-04 |
| BaselinePreset1 | C4 | 64 | -94.81 / -94.81 | -12.21 / -12.21 | -19.02 / -19.02 | -19.6 / -19.6 | 6.7e-05 / 1.9e-04 |
| BaselinePreset1 | C4 | 110 | -86.57 / -86.57 | -14.44 / -14.44 | -24.24 / -24.24 | -19.6 / -19.6 | 5.5e-05 / 2.0e-04 |
| BaselinePreset1 | C7 | 64 | -124.91 / -124.91 | -21.37 / -21.34 | -28.38 / -28.39 | -9.3 / -9.3 | 1.1e-04 / 2.6e-03 |
| BaselinePreset1 | C7 | 110 | -119.54 / -119.54 | -21.34 / -21.31 | -26.42 / -26.43 | -9.3 / -9.3 | 9.8e-05 / 2.6e-03 |
| Belarus_8band_196modes_FPGAexc | A1 | 64 | -72.72 / -72.72 | -16.68 / -16.68 | -98.46 / -98.54 | -5.9 / -5.9 | 1.3e-04 / 3.1e-04 |
| Belarus_8band_196modes_FPGAexc | A1 | 110 | -62.99 / -62.99 | -17.52 / -17.52 | -50.04 / -50.05 | -5.9 / -5.9 | 1.0e-04 / 2.4e-04 |
| Belarus_8band_196modes_FPGAexc | C4 | 64 | -79.07 / -79.07 | -26.70 / -26.70 | -49.77 / -49.78 | -20.0 / -20.0 | 3.3e-05 / 1.4e-04 |
| Belarus_8band_196modes_FPGAexc | C4 | 110 | -67.65 / -67.65 | -26.72 / -26.72 | -36.33 / -36.34 | -20.0 / -20.0 | 2.5e-05 / 8.5e-05 |
| Belarus_8band_196modes_FPGAexc | C7 | 64 | -118.12 / -118.12 | -43.87 / -43.87 | -6.42 / -6.42 | -23.3 / -23.3 | 1.2e-05 / 6.1e-04 |
| Belarus_8band_196modes_FPGAexc | C7 | 110 | -108.57 / -108.57 | -27.44 / -27.43 | -22.76 / -22.77 | -23.3 / -23.3 | 5.1e-05 / 1.3e-03 |
| F15_Elyashev_array512 | A1 | 64 | -110.82 / -110.82 | -3.87 / -3.87 | -84.82 / -84.82 | -13.9 / -13.9 | 3.8e-04 / 5.7e-04 |
| F15_Elyashev_array512 | A1 | 110 | -101.42 / -101.42 | -5.90 / -5.90 | -86.51 / -86.51 | -13.9 / -13.9 | 2.8e-04 / 5.8e-04 |
| F15_Elyashev_array512 | C4 | 64 | -124.79 / -124.79 | -10.42 / -10.42 | -127.10 / -127.10 | -6.3 / -6.3 | 3.8e-05 / 6.3e-05 |
| F15_Elyashev_array512 | C4 | 110 | -116.02 / -116.02 | -13.68 / -13.68 | -127.90 / -127.90 | -6.3 / -6.3 | 2.7e-05 / 5.8e-05 |
| F15_Elyashev_array512 | C7 | 64 | -134.38 / -134.38 | -50.02 / -50.02 | -68.66 / -68.66 | +11.8 / +11.8 | 2.9e-06 / 6.0e-05 |
| F15_Elyashev_array512 | C7 | 110 | -132.41 / -132.41 | -50.32 / -50.32 | -68.65 / -68.65 | +11.8 / +11.8 | 3.6e-06 / 7.3e-05 |

Pitch = FFT peak of the first 1 s (cents vs 12-TET). Stock presets: level 0.00 dB, decay held ≤ 0.03 dB/s,
after release ≤ 0.08 dB/s (= repeat noise), pitch unchanged; only the C7 release part moves measurably
(≤ 2.6e-3 ≈ −52 dB relative) — inaudible, because the stock tail decrement becomes `damper_string²` ≈ 1e-11…1e-8.
F15: unchanged (noise). Template `damper_tail = 127` renders identical before/after (integer multiplier).

## 5. The parameter is now live (`after/`)

Fixed engine, template damper_tail 0 vs ×1000 (0.003…0.11): C4 release decay −36.5 → −42.4 dB/s, A1 −66.5 → −72.0,
C7 held −22.7 → −23.3 (pre-fix: identical). Demo WAVs `DEMO_fixed_Belarus_{A1,C4}_v110_tail0 / _tail_x1000`.

## 6. Tests

`tests/integration/test_tail_damper.py` (2) — FAIL on the unfixed engine, PASS on the fix. Unit 1748 passed
(= baseline), integration 617 passed, `test_fpga_preset_converter.py` 38 passed with the real F_15 inputs.

Raw per-note channel-0 renders (.npy), coefficient dumps and process logs are NOT committed (107 MB); they were kept in the session scratchpad (`tail_damper/raw_renders/`).

## 7. Converter exactness (user 2026-10-03: "use all parameters exactly as in FPGA preset")

PianoidBasic `fpga_*` on `feature/dev-f27f-tail-damper`; F15_Elyashev_array512 regenerated (same template / inputs /
defaults, `output_scale_calibrated = false`).

| # | Where | Old | New (exact) | F_15 effect |
|---|---|---|---|---|
| 1 | `fpga_string_layout.string_physics` | `damper_tail = rint(ratio)` (int) | real ratio `(Damper − Do)·k_ref/damper_string` | tail decrement error 3.2e-3 → 2.2e-16; damper_tail 142 → 142.34 … |
| 2 | `fpga_tables.omega_to_frequency` | `sqrt(W)/(2π dt)` (small-angle) | `acos(1 − W/2)/(2π dt)` (exact phase of the oscillator recurrence) | FPGA run frequency ≤ 0.1 c different |
| 3 | `build_modes` frequency | `omega_coef` Hz | GPU field of the FPGA RUN frequency (`omega_ratio` trim −38 c) via `gpu_mode_frequency` = (sr/π)·sin(π f/sr) | GPU modes were +42 … +151 c sharp of the FPGA; now exact (field −0 … −95 c vs run) |
| 4 | `build_modes` decrement | `dec·sr/omega_coef` | `dec·sr/field` (same per-sample decay) | decay rate unchanged (exact) |
| 5 | `build_modes` mass_inv | `Mass/f²` | `Mass/f² × n_m²` (deck per-mode norm folded back) | relative loop gains exact; k span 35 → 60 dB |
| 6 | `build_output_rows` | `w` | `w / n_m` | output mode weights exact relative |

Kept (forced by engine limits): 16 → 4 outputs, single deck matrix (exact here: Ci_str = −Ci_cos), rank-1 loudness,
6 velocity anchors, 7 ms excitation window (beyond ≤ 2.5e-4), mode-mass cap (host_max absolute anchor), modes 196 of 256
(num_modes + channels ≤ num_strings; middleware mode_channel_index = 196), GPU tail ≥ 1 point, tail tension = main
(ttn_tails == ttn), keys without dampers (one damper_string for release + tail: +18e-6 of the tail excess on release),
negative-shteg u9 wrap, hammer shape family (cap fit; clamps inactive on F_15), speaking offset 21.1 (data fit).

F_15 before / after exactness (fixed engine, offline, 512 / 16; bare soundFloat, pre-output_scale):

| note | v | RMS dB | held decay dB/s | release decay dB/s | pitch c vs FPGA prediction | NaN |
|---|---|---|---|---|---|---|
| A1 | 64 | -110.8 / -155.1 | -3.87 / -3.94 | -84.82 / -84.90 | -7.8 / -7.9 | 0/0 |
| A1 | 110 | -101.4 / -145.6 | -5.90 / -6.04 | -86.51 / -86.66 | -7.8 / -7.9 | 0/0 |
| C4 | 64 | -124.8 / -172.2 | -10.42 / -13.16 | -127.10 / -128.53 | -1.0 / -1.0 | 0/0 |
| C4 | 110 | -116.0 / -162.0 | -13.68 / -16.72 | -127.90 / -129.83 | -1.0 / -1.0 | 0/0 |
| C7 | 64 | -134.4 / -182.4 | -50.02 / -47.59 | -68.67 / -68.99 | +0.9 / -0.8 | 0/0 |
| C7 | 110 | -132.4 / -180.0 | -50.32 / -48.64 | -68.65 / (floor) | +0.9 / -0.8 | 0/0 |

Repeat render of the exact preset: identical within 1e-4 dB / 0.003 dB/s. Bare level −44…−48 dB: the strongest
mode stays at the template coupling (cap) while the exact n_m² spread puts most modes far below it; output_scale
re-derived on load compensates the playback level. Converter tests 46 + tail-damper tests 2 pass.
