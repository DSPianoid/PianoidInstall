# Measured-modes preset F15_measured_plywood_2026-10-15 (dev-a709)

**Status:** built, verified offline, equalized and played on the board, 2026-10-15. **MERGED** (user-approved): Core dev a67f132, Basic dev 4de6f9a (not pushed); engine HEAVY `--both` rebuilt from merged dev. The open questions (§11) stay open.

**User request (2026-10-15):** start from the FPGA-imported preset and replace every mode below 1 kHz with the modes measured on the plywood board. Use all modes found with confidence. Fill 7 sound channels with the measured drive vectors. Give the modes above 1 kHz equal or random channel values. Keep the string couplings as in the FPGA preset. Set the modal masses of the measured modes from the measurement, but critically, at a physically reasonable absolute level. Leave everything above 1 kHz as it is. Use the 196 shaped-modes option.

## 1. What was built

| Item | Value |
|---|---|
| Preset | `PianoidCore/pianoid_middleware/presets/F15_measured_plywood_2026-10-15.json` (no `_listening` variant: the 7 outputs are exciter feeds, see §6) |
| Base | `F15_Elyashev_array512.json` (Core dev, §12/§13 of the [FPGA port proposal](../proposals/fpga-to-gpu-preset-port-2026-09-30.md)), not modified |
| Builder | `PianoidBasic/Pianoid/measured_mode_preset.py` (CLI `python -m Pianoid.measured_mode_preset BASE MEASURED --out OUT`), next to the FPGA converter |
| Measured table | `docs/development/diagnostics/dev-a709-measured-preset/measured_modes.json`, also embedded in the preset as `measured_modes_build.measured_table` |
| Derivation scripts | `dev-a709-measured-modes-2026-10-15.py` (residues per ampere), `dev-a709-measured-table-2026-10-15.py` (selection, damping, masses, channels), `dev-a709-verify-preset-2026-10-15.py` (offline engine check), all in `docs/development/diagnostics/` |
| Load parameters | `array_size 512`, `string_iterations 16`, 48 kHz, 64 samples per cycle, `listen_to_modes 0`, `sound_derivative_order 1`, unchanged from F15 |
| Layout | 196 modes on the legacy full-deck path. 7 channels. 236 strings in 59 blocks (F15 has 232 and 58): the 7 output strings plus one spare need a second output block |

| Mode block | Count | Source |
|---|---|---|
| `0..37` | 38 | measured modes below 1 kHz (66.6 to 979.1 Hz), sorted by frequency |
| `38..179` | 142 | F15 modes at or above 1 kHz, verbatim and in their order (1019.6 to 8255.2 Hz) |
| `180..195` | 16 | the next FPGA modes 196..211 (8255 to 8434 Hz), converted from the F_15 tables with the exact converter (§8) |
| dropped | 54 | every F15 mode below 1 kHz (44.5 to 996.1 Hz) |

## 2. Inputs (10-15 configuration, weights on the exciters)

- **Poles and shapes.** 45 modes from three 7×7 runs: `D:\modal_measurements\rig_checks\20261015T124849-appropriation\prep.json`. Below 200 Hz they come from a consensus fit, from 200 to 1100 Hz from PolyMAX. Each mode has f, ζ, rank-1 share, repeat MAC, cross-exciter MAC, u (P1 to P8) and `v_current` (E1 to E7, at equal coil-current RMS).
- **Live validation.** 24 core modes (`eval.json` of `…124849-appropriation` and `…135644-appropriation-extra7`). Driving each with its own vector gave a median of −0.3 dB against the optimum on the target mode.
- **Damping.** Focused stop-and-decay (`20261015T142258-q-decay/q_decay.json`) and the Q-confidence classes (`q-confidence-20261015/q_classes.json`).
- **Residue scale.** `prep.json` stores only unit vectors, so this note recomputed the residues. It reused the same poles (no re-fit), the same LSFD bands and the same coil admittance. Result: `measured_residues.json`, with σ1 of the 8×7 residue matrix per ampere, the E7/P8 driving point, `max|u|`, `max|v|` and |Y_e(f)|.
- **Board.** 8 mm plywood, about 1200 × 1000 mm (`layout-20261014/board_layout.json`; thickness from the user).

## 3. Mode selection below 1 kHz

**Rule.** Keep the 24 live-validated core modes. Keep every other mode whose shape repeats over the three runs (repeat MAC ≥ 0.9), even if it overlaps a neighbour. Drop the rest. Every sub-200 Hz mode in `prep.json` comes from the consensus fit, so "no consensus support" removes nothing on its own.

| Kept | Count |
|---|---|
| core (live-validated) below 1 kHz | 23 (the 24th core mode, 1010.38 Hz, is above the boundary) |
| other, repeat MAC ≥ 0.9 | 15: 140.28, 174.48, 277.05, 432.42, 475.76, 493.87, 542.66, 546.50, 617.88, 637.72, 671.73, 751.39, 835.78, 921.12, 979.11 Hz |

| Dropped | Reason |
|---|---|
| 49.69 Hz | Mains-adjacent (0.6 % below 50 Hz). Cross-exciter MAC 0.12 is at chance level. Its mode vector is −6.2 dB from the optimum. It is not live-validated, and earlier days found nothing at 49 to 50 Hz (only 53.2 Hz, "confirmed, weak"). Judged mains-contaminated |
| 180.45, 759.44, 952.96 Hz | repeat MAC 0.81 / 0.84 / 0.81 (< 0.85: poor) |
| 741.94, 960.19 Hz | repeat MAC 0.89 / 0.88 (between 0.85 and 0.9: below the inclusion threshold). Their mode vectors do not reproduce the optimum (MAC 0.11 / 0.06), so their drive vectors are ill-defined |
| 1010.38 Hz | A core mode, but above the user's 1 kHz boundary. The FPGA modes are kept there (open question 3) |
| 32.7 Hz | Not in today's `prep.json` (settled by the user as "not to pursue"). Excluded |

## 4. Frequency and damping

### 4.1 Frequency field

The GPU mode recurrence `x[n+1] = (1−d)(2−w)·x[n] − (1−d)²·x[n−1]` has poles `(1−d)·e^(±iθ)` with `cos θ = 1 − w/2`. Damping does not move θ. So the mode plays `acos(1 − w/2)·sr/2π` Hz: the damped frequency ([Basic OVERVIEW → Piano_mode](../modules/pianoid-basic/OVERVIEW.md#piano_mode-and-modemap)). The measured f is a damped natural frequency. It is stored with the converter's `gpu_mode_frequency(f) = (sr/π)·sin(πf/sr)`, so the engine plays f exactly (+0 to −1 c in the field below 1 kHz). The FPGA modes keep their own field (the FPGA running frequency, §12 of the proposal).

### 4.2 ζ → `decrement`

The per-sample amplitude factor is `1 − dec`, with `dec = decrement·f/sr`. The exact decay rate is γ = ζ·2π·f_n, with `f_n = f/√(1−ζ²)`. So `dec = 1 − e^(−γ/sr)` and `decrement = dec·sr/f_field`. This is the converter's host_q law with γ taken from ζ.

### 4.3 Which ζ (recommendation of the measurement agent, applied)

| Rule | Modes |
|---|---|
| stop-and-decay ζ, the "tight" decay class | 599.23, 650.09, 715.54, 820.53, 875.81, 900.96 Hz |
| PolyMAX ζ, capped by the decay ζ where one exists (the decay is an upper bound) | all others. The cap applies only at 796.51 Hz (decay 1.36 % < PolyMAX 1.43 %) |
| **220.07 Hz (flagged):** PolyMAX 0.83 % | The PolyMAX runs agree (0.76 / 0.84 %) and the q-confidence class is "tight". The decay value (1.93 %) is "beating" with 232 Hz and "poor". PolyMAX is the better-supported number. If 1.9 % is right, the mode rings 2.3× shorter (τ 38 ms instead of 87 ms) |

All ζ include the 2 to 8 % (relative) electrical damping of the attached exciters. The preset models the board as it is now, with exciters and weights, so no correction was applied.

## 5. Modal masses

### 5.1 The measured relative scale, critically

- **Estimator.** For a mode, the residue matrix per ampere is `R = σ1·u·vᴴ` (rank 1). If the shape is scaled to max 1 at the sampled points, then |φ_P| = 1/max|u| and |φ_E| = 1/max|v|. So `1/m ∝ σ1·max|u|·max|v|`. This uses all 56 sensor×exciter residues. The E7/P8 driving point alone is unusable wherever E7 is near a node (`u8` < 0.2 for 18 modes).
- **Trend.** Over the 38 kept modes, `σ1·max|u|·max|v| ∝ f^2.15`. The driving point gives the same trend (f^2.21), so it comes from the instrument chain: piezo strain sensing (∝ curvature), the piezo into a line input, and no calibrated force. It does not come from the board. A thin plate's modal mass (shape scaled to max 1) is about M/4 at every frequency, so **the trend was removed**. The measurement supplies only the per-mode deviation.
- **Scatter.** The per-mode residual has an SD of 4.5 dB. **Clip: ±6 dB** (a factor of 2 in mass). For a uniform plate, modal masses stay within about M/8 to M/2. A larger deviation means a poorly isolated residue (overlap, or E-side shape sampling), not physics. Corrected values:

| Mode | Residual | Applied | Note |
|---|---|---|---|
| 174.48 Hz | −16.8 dB (7× heavier) | −6.0 dB | ζ 0.79 %, rank-1 share 0.46; the E7/P8 driving point says +1.6 dB |
| 220.07 Hz | −6.2 dB | −6.0 dB | the damping-flagged mode |
| 383.64 Hz | +6.5 dB | +6.0 dB | |
| 419.08 Hz | +8.5 dB | +6.0 dB | |
| 820.53 Hz | +6.6 dB | +6.0 dB | |

### 5.2 Absolute level

| Step | Value |
|---|---|
| Board mass | **8 mm plywood** (user, 2026-10-15), 1.2 × 1.0 m, density 550 to 700 kg/m³ → M = 5.3 to 6.7 kg. **Used: 650 kg/m³ → M = 6.24 kg.** The 7 exciters with weights add local mass on top (not included). Cross-check: the 36 resolved modes in 200 to 1000 Hz (0.045 /Hz, a lower bound because 7 points do not resolve every mode) imply h ≤ about 12 mm with E ≈ 8 GPa, which is consistent |
| Modal mass | nominal m0 = M/4 = 1.56 kg (range 1.33 to 1.68 kg over the density range). Per mode `m = m0 / mass_inv_rel` = **0.78 to 3.1 kg (M/8 to M/2)**, listed in the table (§12) |
| GPU unit | the engine's `mass_inv` multiplies the bridge force, in a unit that has no physical calibration (the converter's mode-mass scale is UNCONFIRMED, [Basic OVERVIEW → FPGA converter](../modules/pianoid-basic/OVERVIEW.md#fpga-preset-converter)). So kg cannot be converted directly |
| Anchor (continuity across 1 kHz) | `mass_inv = mass_inv_rel × A`. A = the **geometric mean `mass_inv` of the 14 F15 modes in 1000 to 1500 Hz = 5.29e-13** (interquartile 5.2e-14 to 3.0e-12). The measured modes therefore sit at the level of the FPGA modes just above the boundary, at a constant level (constant physical modal mass), with the measured per-mode deviation |
| Result | `mass_inv` 2.65e-13 to 1.06e-12. Largest `k = mass_inv·(2πf)²` of a measured mode: 4e-5, far below the stable anchor 0.1 |

**Consequence (flagged).** The F15 modes below 1 kHz follow the FPGA mass law (Mass/f²·n_m²). Their geometric mean is 2.8e-11, and mode 0 (44.5 Hz) is 1.28e-6 (k = 0.1, the mode that dominated F15's output). The measured low modes are 34 dB below that mean and 128 dB below the old mode 0. The new preset no longer has F15's single dominant bass mode. The engine re-derives the playback level (Layer B, §10).

## 6. Sound channels

- **Convention (docs + measurement).** The preset plays in strings mode (`listen_to_modes 0`). Output channel k is output pitch `128 + k`. The pitch's deck **feedback row holds the per-mode channel weights**, and its feedin row is 0 ([Basic OVERVIEW → Output Pitches](../modules/pianoid-basic/OVERVIEW.md#output-pitches-receiver-points), [SYNTHESIS_ENGINE → Sound-Channel Gain Path](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#sound-channel-gain-path-strings-mode)). As in F15's `decka`, the outputs are per-transducer drives (proposal §13). The measured channel ratios are in §10.
- **Order.** Channels 0..6 = E1..E7 (output pitches 128..134).
- **Measured modes.** The weights are `v_current` (the drive vector at equal coil current, i.e. equal force above the 32 to 45 Hz exciter resonances). It is made real by the real-normal-mode projection: rotate by the phase of the largest entry, take the real part, scale to max |·| = 1. The projection keeps 52 to 97 % of the vector's energy (median 0.88). The low ones (599.23, 751.39, 921.12, 140.28, 94.78 Hz) are strongly complex: two overlapping modes, or non-proportional damping.
- **Modes ≥ 1 kHz (FPGA and fill).** Every channel gets the same magnitude with a random sign (`numpy` seed 0), so the 7 outputs are not coherent. The magnitude is 0.527 = the median measured ‖v‖ / √7. Each high mode therefore gets the same total drive as a typical measured mode. Using max = 1 instead would put +4 dB more into every high mode (option `--hf-level max`).
- **Scale.** One common factor so that the largest |weight| = 430, the F15 output-row maximum (the template convention, so `output_scale` stays in F15's range).
- **Spare string.** 7 output strings do not fill blocks of 4. Output pitch 134 (E7) owns two strings (234, 235). They share the pitch's deck row, so they write the same sample: measured, no level change (§10).
- **Routing (physical, 10-15 rig).** E1 → Out 9, E2 → Out 10, E3..E7 → Out 3..7. The engine's channel k goes to device output k + 1 (ASIO), so channels 0/1 (E1/E2) need routing to Out 9/10 (open question 2).
- **Voltage trim (information).** The weights are in the current (force) domain, but the amplifiers are driven by voltage. The coil admittance |Y_e| (current per volt, 10-15 coil run) is flat over 60 to 1000 Hz within 0.1 dB per exciter: E1 +4.7, E2 +4.5, E3 +0.3, E4 −4.5, E5 −3.5, E6 −0.8, E7 −0.7 dB re the mean. Delivering the equal-force vectors therefore needs per-channel output gains of −4.7 / −4.5 / −0.3 / +4.5 / +3.5 / +0.8 / +0.7 dB. These are not baked into the preset (open question 2).

## 7. String couplings

- **Mapping (decision, user may revisit).** Each measured mode inherits the piano-deck column (feedin = feedback, signed, per-mode normalised) of an F15 mode below 1 kHz: the nearest in log-frequency. It takes a distinct column whenever a free one is within 50 cents of the nearest; otherwise the column is shared.
  - Median distance 18 c, maximum 111 c (66.58 Hz ← 71.0 Hz).
  - 4 columns are shared by 2 measured modes each: 612.0 Hz (599.23 / 617.88), 651.3 Hz (637.72 / 650.09), 666.4 Hz (671.73 / 693.63), 846.0 Hz (820.53 / 835.78).
  - 18 F15 columns below 1 kHz are unused.
  - A strictly one-to-one assignment was rejected: F15 has fewer modes than the board in 400 to 800 Hz, so it shifts by up to 330 c.
- **Modes ≥ 1 kHz.** Their F15 columns are unchanged.
- **Physical meaning.** This plywood board has no bridge. The couplings remain F15's string ↔ mode pattern. They are not a property of the measured modes.

## 8. Mode count: 196 shaped

- **Engine constraints (docs + measured load).** Legacy full-deck path, so `num_modes + num_channels ≤ num_strings`: 196 + 7 = 203 ≤ 236. Blocks hold 4 strings each, and `num_strings` divides by the 59 blocks. That is ≤ 64 blocks (SEGMENT_FOR_SHUFFLE_SUMMATION), within `NUM_CHANNELS = 8` and `MAX_ARRAY_SIZE 512` ([string-mode coupling context §8.1](string-mode-coupling-mode-scaling-context-2026-06-06.md), [Basic OVERVIEW → ModeMap](../modules/pianoid-basic/OVERVIEW.md#piano_mode-and-modemap)). The load measured `num_modes_for_model = 236` and `mode_channel_index = 196`.
- **Fill.** 38 measured + 142 F15 modes = 180, so 16 short of 196.
  - The next 16 FPGA modes (FPGA indices 196..211) are converted with the converter's own `build_modes` / `build_deck_rows`. They are rescaled to F15's mass scale. The builder first checks that the same call reproduces all 196 F15 modes exactly (relative difference 0).
  - **Correction:** two of them (FPGA 198 and 200, 8.26 and 8.29 kHz) would have k = 0.245, above the converter's measured-stable anchor 0.1 (F15's own maximum). Both are capped at k = 0.1.
- The 2000-mode flat tail (T2 to T4) is for later, as the user asked.

## 9. Engine changes this preset needed (on the branch; approved by the user)

| # | Change | Why (measured / history) |
|---|---|---|
| 1 | **Channel count from the preset, up to `NUM_CHANNELS` = 12.** `pianoid_middleware/audio_channels.py` reads `mode_sound_channels.num_channels` (legacy 4), validates `1..12` against `pianoidCuda.NUM_CHANNELS`; `pianoid.py` uses it | `pianoid.py` forced `num_channels = 4` since Core 5282bc3 (2025-09-19, "Mode channels"; before: `len(sound_pitches)`). The 7-channel preset got 4-channel sound buffers (`dev_soundFloat` 256 = 64 × 4) and output pitches 132..134 wrote past them |
| 2 | **`constants.h` `NUM_CHANNELS` 8 → 12, the single bound**; `dev_sound_prev_diff` / `dev_limiter_peak` (`Pianoid.cu`, `Pianoid_debug.cu`) sized `NUM_CHANNELS` (were 4); `CircularBuffer` host arrays follow | designed maximum 12 = output pitches 128..139 (FIR docs 2025-10: 12 input channels). The 4-element buffers (f178ad8, 24d5251) are indexed per channel by the kernel (atomicMax every sample) |
| 3 | **ASIO engine channel → device output map** (callback driver): `PIANOID_AUDIO_OUTPUT_MAP` env of the backend, applied via `pianoidCuda.setAsioOutputMap`; unmapped outputs silenced; default identity ([AUDIO_DRIVERS](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver)) | ASIO always played engine ch k on device output k (outputs 0..7 only), so E1/E2 on Out 9/10 were unreachable |

GPU budget: the 12-channel layout is 3 output blocks; the init cooperative pre-flight already rejects a grid that does
not co-reside (`coop_launch_shortage`). FE sound-channel editors and the SDL drivers have no channel cap
(data-driven / stereo downmix). Not fixed (reported): the legacy non-callback ASIO path (type 1) indexes its
8-element packet by every device output (pre-existing, unused by default) — it now rejects a map.
A library preset still adopts the running engine's channel count; this preset cannot be D2D-switched anyway (236
strings → 409, APPLY).

**Install:** merged into Core dev a67f132 and rebuilt there (HEAVY `--both`, `pianoidCuda.NUM_CHANNELS` 12 in both
variants). 4-channel regression: BaselinePreset1 p60 + C-major chord, offline, before vs merged max |diff| / peak
2.1e-4, identical to the engine's own run-to-run spread (2.5e-4). `/load_preset` 200 for BaselinePreset1 (4 ch) and
F15_measured_plywood_2026-10-15 (7 ch).

## 10. Verification (offline, audio off, separate process, engine with fixes 1 + 2)

| Check | Result |
|---|---|
| Load | `num_modes 196`, `num_channels 7`, `num_strings 236`, `mode_channel_index 196`. Sound buffers 448 = 64 × 7; channel buffers 12 |
| Readback (`getModeDisplacements`) vs preset, all 196 modes | max relative error: dec 5.0e-8, omega 5.6e-8, mass_inv 5.6e-8 (float32) |
| Mode probe (each measured mode excited alone, free ring 400 ms) | **frequency within 0.16 c** for all 38; **ζ within 0.8 %** of the assigned value (median 0.0 %) |
| Channel mapping | per-channel RMS / |row weight| equal within 0.010 dB for every probed mode. Channel 6 (2-string output pitch) is within 0.008 dB of the others: no doubling |
| Notes p60, p100 v127 | finite, 0 clipped samples, per-channel peaks −19.9 to −26.3 dBFS at the calibrated level |
| Modes in a note | p100 (all string partials ≥ 2.6 kHz): the 23 strongest spectral peaks below 1 kHz are all within 25 c of a measured mode, 21 of them within 2.1 c |
| Equalization (§10a) | synthesis RMS spread over the 88 keys at v95: **32.2 dB → 0.0014 dB** |
| Layer B (engine chord headroom, after equalization) | worst canonical chord oct_chain_C_8 is +21.9 dB above p60 → target **p60 −27.91 dBFS** (chord peak −6 dBFS @ slider 64). Persisted in the preset with `output_scale` |
| Re-verify after equalization | frequency within 0.16 c, ζ within 0.8 % (median 0.2 %), channel ratios within 0.010 dB; p60 / p100 finite, 0 clipped, per-channel peaks −21.6 to −32.0 dBFS |

The verification-surface rule is met offline, not live: the stack and ASIO belong to the rig agent today, and no live realtime backend ran an offline render.

## 10a. Keyboard equalization

- **Tool (documented):** the synthesis equalizer `CalibrationController.calibrate_synthesis` (= `POST /calibrate_synthesis`, [middleware OVERVIEW → CalibrationController](../modules/pianoid-middleware/OVERVIEW.md#calibrationcontroller-calibration_controllerpy)). Per key: one offline render (note 300 ms, RMS over all 7 output channels, 30–300 ms), then a direct linear correction of the per-pitch `hammer_mass` (RMS ∝ mass). It ends with `rescale_masses_to_physical_range` (one common factor; `output_scale` compensates).
- **Safety:** run offline in-process (`dev-a709-equalize-preset-2026-10-15.py`): audio off, engine never started, never a live backend. The target is the keyboard's median RMS at v95. The metric is flat synthesis RMS; no perception curve was applied.
- **Result.** Spread (max − min over 88 keys): **32.2 dB → 0.0014 dB** (SD 5.0 → 0.0002 dB).
  - Before, relative to the median: the bass is up to +8.8 dB, mid C5..B5 up to +14.5 dB, and the top octave −7.5 to −17.7 dB.
- **Mass range (flagged).** The needed masses span 39.4 dB, more than the 20 dB physical range (2 to 20 g).
  - The heaviest (p108) is pinned to 20 g. 58 keys fall below 2 g (down to 0.21 g, a 19.4 dB violation).
  - This is the documented outcome. The evenness is kept and the level is compensated.
- **Layer B.** Calibrated after the equalization (above). Persisted.

## 10b. Live playback on the board (2026-10-15, user-approved)

Setup and routing check:
- Backend from the branch (`wt-a709-core`), ASIO callback, `PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6`.
- E2 row × 0.5 (−6 dB) for the session.
- Script: `diagnostics/dev-a709-live-playback-2026-10-15.py`. Results: `dev-a709-measured-preset/live/`.

| Step | Result |
|---|---|
| Routing tone per channel (others muted; p69 v127 at init volume 89; `/measure_rms` on piezo P1 = In 1) | all-muted baseline −90.3 dB. Each exciter alone: E1 −69.3, E2 −63.4, E3 −75.6, E4 −81.3, E5 −68.2, E6 −60.9, E7 −66.5. Every channel drives the board, and E1/E2 arrive via Out 9/10; with identity routing they would have gone to the monitor-only Out 1/2. Output peak −42 dBFS |
| Chords, v80, 3 s each (C major, A minor, open low C2 G2 E3, open high C6 E6 G6 C7) | volume 89: peak −38.3 dBFS. Ramp to volume 95: per-output latched peaks E1..E7 −35.0 / −36.2 / −33.4 / −35.7 / −33.1 / −33.9 / −31.1 dBFS. No clipping, no limiting, audio state ok |
| MIDI | `/midi_playback` → 500 (`pretty_midi` imports `pkg_resources`, which the shared venv lacks: a pre-existing environment defect). `elise.mid` was streamed instead through `POST /play` (mido, real time, sustain pedal): the first 120 s of 165.6 s. Peaks E1..E7 −35.4 / −40.3 / −36.7 / −38.0 / −34.4 / −39.1 / −35.9 dBFS, no clipping, 0 produce timeouts |

All per-output peaks stayed ≤ −31 dBFS (ceiling −30), with E2 at −6 dB. The acoustic result (distortion, rattle,
balance) was judged by ear by the user; the agent had no listening microphone.

## 11. Open questions for the user (kept open, user 2026-10-15)

1. **Bass weight.** At physically constant modal masses anchored to the FPGA level at 1 kHz, the measured low modes are about 34 dB weaker than F15's sub-1 kHz modes, and F15's dominant 44.5 Hz mode is gone. Is that the intended "physical" balance, or should the measured band be lifted by a fixed offset (one number)?
2. **Voltage trims.** Routing is solved (the output map, §9). Should the per-channel voltage trims (§6: E1..E7 −4.7 / −4.5 / −0.3 / +4.5 / +3.5 / +0.8 / +0.7 dB) be applied in the output stage, baked into the rows, or left off?
3. **Boundary.** The live-validated 1010.38 Hz mode is excluded by the strict 1 kHz boundary. Should the boundary move to about 1.02 kHz to include it (one FPGA mode at 1019.6 Hz would be dropped)?
4. **220.07 Hz damping.** 0.83 % is kept; 1.9 % is the alternative.
5. **Couplings.** The nearest-frequency F15 columns are a placeholder: this board has no bridge or string positions. Keep them, or derive couplings from the measured shapes at notional bridge points?
6. **Equalization range.** The keyboard needs 39 dB of hammer-mass range (58 keys below 2 g). Accept, or reshape (e.g. a perception curve, or a smaller target spread)?
7. **MIDI player.** Fix the venv (`setuptools` < 81 for `pkg_resources`), or drop the `pretty_midi` dependency from `MidiRecord`? **Decided (user, 2026-10-17):** drop `pretty_midi`; MIDI files are read with `mido` (`midi_file_reader.py`, dev-672e).

## 12. Mode table (measured, modes 0..37)

ζ source "decay" = stop-and-decay. "1/m rel" = the per-mode residual after the f^2.15 trend is removed (clip ±6 dB). m (kg) = 1.56 kg / mass_inv_rel. E1..E7 = channel weights before the common scale (×430 in the preset). "coupling from" = the F15 mode whose deck column the mode inherits (Hz, cents re f).

| # | f (Hz) | ζ (%) | Q | ζ source | 1/m rel (dB) | m (kg) | mass_inv (GPU) | E1 | E2 | E3 | E4 | E5 | E6 | E7 | real-proj. energy | coupling from (Hz, c) | kept as |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 66.58 | 3.19 | 16 | PolyMAX | +4.9 | 0.89 | 9.27e-13 | +0.95 | -0.17 | -0.71 | +0.30 | +1.00 | +0.25 | -0.18 | 0.93 | 71 (+111) | core |
| 1 | 94.78 | 2.84 | 18 | PolyMAX | +2.5 | 1.16 | 7.09e-13 | -0.18 | +0.83 | +1.00 | -0.39 | +0.72 | +0.04 | -0.40 | 0.65 | 95 (+6) | core |
| 2 | 133.19 | 2.32 | 22 | PolyMAX | -1.3 | 1.81 | 4.57e-13 | +0.06 | +1.00 | -0.13 | +0.93 | -0.03 | -0.07 | -0.67 | 0.94 | 133 (-7) | core |
| 3 | 140.28 | 2.85 | 18 | PolyMAX | -2.7 | 2.13 | 3.87e-13 | +1.00 | -0.08 | +0.40 | +0.03 | +0.42 | +0.17 | +0.13 | 0.70 | 137 (-44) | rep 0.92 |
| 4 | 174.48 | 0.79 | 63 | PolyMAX | -16.8 → -6.0 clip | 3.11 | 2.65e-13 | +0.18 | +0.03 | +0.35 | +1.00 | +0.38 | +0.34 | +0.32 | 0.60 | 183 (+86) | rep 0.94 |
| 5 | 189.01 | 2.26 | 22 | PolyMAX | -0.4 | 1.63 | 5.06e-13 | -0.52 | -0.19 | +0.86 | -0.08 | +1.00 | +0.22 | +0.26 | 0.90 | 191 (+21) | core |
| 6 | 198.78 | 2.19 | 23 | PolyMAX | +5.2 | 0.86 | 9.59e-13 | +0.16 | -0.15 | +0.12 | -0.13 | -0.28 | -0.13 | +1.00 | 0.86 | 192 (-61) | core |
| 7 | 220.07 | 0.83 | 60 | PolyMAX (flag, §4.3) | -6.2 → -6.0 clip | 3.11 | 2.65e-13 | +0.43 | +0.28 | -0.59 | -0.41 | +1.00 | +0.53 | +0.15 | 0.90 | 213 (-59) | core |
| 8 | 232.13 | 2.50 | 20 | PolyMAX | +1.8 | 1.26 | 6.54e-13 | +1.00 | -0.96 | +0.52 | -0.27 | +0.61 | +0.11 | +0.03 | 0.97 | 232 (-2) | core |
| 9 | 277.05 | 2.33 | 21 | PolyMAX | +5.9 | 0.79 | 1.04e-12 | -0.28 | +0.21 | +1.00 | -0.32 | -0.29 | -0.04 | -0.04 | 0.77 | 280 (+16) | rep 0.99 |
| 10 | 316.95 | 1.90 | 26 | PolyMAX | +0.6 | 1.45 | 5.70e-13 | +0.15 | +1.00 | +0.02 | +0.40 | -0.39 | +0.21 | +0.13 | 0.82 | 313 (-21) | core |
| 11 | 341.40 | 2.31 | 22 | PolyMAX | +1.0 | 1.39 | 5.94e-13 | -0.89 | +0.98 | +0.12 | +0.70 | -0.52 | +1.00 | -0.13 | 0.88 | 344 (+12) | core |
| 12 | 354.94 | 1.77 | 28 | PolyMAX | +1.4 | 1.33 | 6.20e-13 | -0.08 | -0.07 | +0.28 | -0.09 | +1.00 | -0.43 | +0.22 | 0.80 | 362 (+35) | core |
| 13 | 383.64 | 1.89 | 26 | PolyMAX | +6.5 → +6.0 clip | 0.78 | 1.06e-12 | +0.01 | +0.25 | -0.08 | -0.23 | -0.33 | -0.13 | +1.00 | 0.69 | 381 (-10) | core |
| 14 | 419.08 | 3.00 | 17 | PolyMAX | +8.5 → +6.0 clip | 0.78 | 1.06e-12 | +0.18 | +0.93 | -0.10 | -0.31 | +1.00 | -0.18 | +0.27 | 0.95 | 411 (-33) | core |
| 15 | 432.42 | 2.35 | 21 | PolyMAX | -1.2 | 1.79 | 4.60e-13 | +0.19 | +0.62 | +0.01 | +0.08 | +1.00 | -0.19 | +0.26 | 0.95 | 436 (+13) | rep 0.97 |
| 16 | 475.76 | 2.11 | 24 | PolyMAX | -2.2 | 2.02 | 4.09e-13 | +0.18 | +0.61 | -0.00 | +0.66 | +1.00 | +0.19 | -0.25 | 0.97 | 474 (-7) | rep 0.91 |
| 17 | 493.87 | 2.27 | 22 | PolyMAX | -1.7 | 1.89 | 4.36e-13 | -0.47 | +0.70 | +0.74 | -0.28 | +0.15 | -0.37 | +1.00 | 0.90 | 493 (-3) | rep 0.97 |
| 18 | 504.94 | 1.89 | 26 | PolyMAX | +1.6 | 1.29 | 6.38e-13 | -0.31 | +0.07 | +0.10 | -0.92 | +0.05 | +0.01 | +1.00 | 0.92 | 503 (-6) | core |
| 19 | 542.66 | 1.62 | 31 | PolyMAX | +3.6 | 1.03 | 7.98e-13 | -0.62 | +1.00 | +0.66 | -0.90 | -0.19 | -0.21 | +0.42 | 0.89 | 528 (-47) | rep 0.97 |
| 20 | 546.50 | 1.57 | 32 | PolyMAX | +1.8 | 1.27 | 6.50e-13 | -0.35 | +1.00 | +0.67 | -0.25 | -0.04 | -0.06 | +0.29 | 0.67 | 515 (-102) | rep 0.92 |
| 21 | 567.65 | 1.35 | 37 | PolyMAX | -4.0 | 2.46 | 3.36e-13 | +0.17 | -0.54 | -0.77 | +1.00 | +0.69 | +0.01 | +0.06 | 0.86 | 567 (-1) | core |
| 22 | 583.74 | 1.77 | 28 | PolyMAX | -2.3 | 2.03 | 4.08e-13 | -0.68 | -0.42 | -0.01 | +1.00 | +0.22 | +0.64 | -0.02 | 0.95 | 579 (-13) | core |
| 23 | 599.23 | 1.43 | 35 | decay (tight) | +1.9 | 1.26 | 6.56e-13 | +0.53 | +1.00 | -0.50 | -0.09 | -0.12 | -0.10 | +0.58 | 0.53 | 612 (+37) | core |
| 24 | 617.88 | 1.75 | 29 | PolyMAX | -4.4 | 2.59 | 3.18e-13 | +0.63 | +0.52 | -0.18 | +1.00 | -0.94 | -0.34 | +0.36 | 0.88 | 612 (-16) | rep 0.96 |
| 25 | 637.72 | 1.47 | 34 | PolyMAX | -1.9 | 1.95 | 4.24e-13 | +1.00 | -0.31 | +0.20 | -0.34 | +0.01 | -0.14 | -0.22 | 0.74 | 651 (+36) | rep 0.97 |
| 26 | 650.09 | 1.50 | 33 | decay (tight) | -2.5 | 2.07 | 3.98e-13 | -0.45 | -0.57 | +0.83 | +0.12 | -0.44 | +0.11 | +1.00 | 0.92 | 651 (+3) | core |
| 27 | 671.73 | 1.77 | 28 | PolyMAX | -3.7 | 2.39 | 3.45e-13 | +0.06 | +0.22 | +0.03 | +0.59 | +1.00 | -0.38 | -0.73 | 0.84 | 666 (-14) | rep 0.92 |
| 28 | 693.63 | 1.43 | 35 | PolyMAX | -4.0 | 2.47 | 3.34e-13 | +0.33 | +1.00 | +0.42 | -0.18 | +0.65 | +0.27 | +0.67 | 0.87 | 666 (-69) | core |
| 29 | 715.54 | 1.32 | 38 | decay (tight) | -3.9 | 2.43 | 3.39e-13 | -0.19 | -0.09 | +0.63 | -0.27 | +1.00 | -0.22 | +0.51 | 0.94 | 735 (+47) | core |
| 30 | 751.39 | 1.59 | 31 | PolyMAX | +5.7 | 0.81 | 1.02e-12 | +0.19 | +0.27 | +0.23 | +0.28 | +1.00 | +0.20 | -0.07 | 0.52 | 753 (+3) | rep 0.92 |
| 31 | 796.51 | 1.36 | 37 | decay (< PolyMAX 1.43) | -0.3 | 1.61 | 5.13e-13 | +1.00 | -0.25 | +0.17 | -0.09 | -0.38 | -0.10 | +0.62 | 0.94 | 771 (-57) | core |
| 32 | 820.53 | 1.50 | 33 | decay (tight) | +6.6 → +6.0 clip | 0.78 | 1.06e-12 | -0.38 | -0.15 | -0.04 | -0.44 | +1.00 | +0.07 | +0.03 | 0.81 | 846 (+53) | core |
| 33 | 835.78 | 1.56 | 32 | PolyMAX | +0.7 | 1.43 | 5.76e-13 | +0.19 | +1.00 | -0.35 | +0.38 | +0.33 | -0.28 | -0.44 | 0.81 | 846 (+21) | rep 0.98 |
| 34 | 875.81 | 1.31 | 38 | decay (tight) | +2.5 | 1.17 | 7.04e-13 | +1.00 | +0.66 | -0.32 | -0.22 | -0.33 | -0.07 | -0.03 | 0.92 | 866 (-20) | core |
| 35 | 900.96 | 1.22 | 41 | decay (tight) | -2.2 | 2.01 | 4.10e-13 | -0.42 | +1.00 | +0.43 | +0.51 | -0.79 | -0.26 | +0.53 | 0.90 | 907 (+12) | core |
| 36 | 921.12 | 1.28 | 39 | PolyMAX | -3.9 | 2.43 | 3.39e-13 | +0.28 | +0.24 | +0.19 | -0.02 | +1.00 | +0.27 | +0.05 | 0.54 | 929 (+14) | rep 0.98 |
| 37 | 979.11 | 1.16 | 43 | PolyMAX | +2.8 | 1.13 | 7.29e-13 | -0.42 | +0.93 | -0.03 | -0.05 | +1.00 | -0.31 | +0.25 | 0.74 | 973 (-11) | rep 0.96 |

## 13. Reproduce

```
# 1. residues per ampere (reads the recorded 10-15 sessions; needs the dev-fd69 modal_adapter on PYTHONPATH)
PYTHONPATH=D:/repos/wt-fd69-core PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-a709-measured-modes-2026-10-15.py \
    D:/modal_measurements/rig_checks/20261015T124849-appropriation/prep.json docs/development/diagnostics/dev-a709-measured-preset/measured_residues.json
# 2. measured table (selection, damping, masses, channels)
PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-a709-measured-table-2026-10-15.py D:/modal_measurements/rig_checks \
    docs/development/diagnostics/dev-a709-measured-preset/measured_residues.json docs/development/diagnostics/dev-a709-measured-preset/measured_modes.json
# 3. preset (from PianoidBasic/Pianoid; the fill reads the F_15 tables + converter template named in the base's fpga_conversion)
python measured_mode_preset.py <Core>/pianoid_middleware/presets/F15_Elyashev_array512.json <measured_modes.json> --out <Core>/pianoid_middleware/presets/F15_measured_plywood_2026-10-15.json
# 4. offline verification + Layer B (chord headroom)
PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-a709-verify-preset-2026-10-15.py <preset> <out_dir> --core <Core>
```
