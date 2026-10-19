# Soundboard mode discovery: consolidated report (2026-10-14)

Supersedes report-mode-discovery-2026-10-12.md. That report stays unchanged because it was sent to Dima; see it for theory and method details. This version covers the sessions of 10-12, 10-13 and 10-14. Data: D:\modal_measurements\rig_checks\. Session log: logs/archive/dev-fd69-2026-10-11-165927.md. Plan: proposals/modal-current-referenced-program-2026-10-14.md.

Two terms:
- **MAC** measures how alike two mode shapes are: 1 = identical, about 0.1-0.3 = no better than chance with 7 sensors.
- A **pole** is one identified mode, with its frequency and damping.

## 1. Setup history

| Date | Exciters → outputs | Sensors → inputs | Reference |
|---|---|---|---|
| 10-11/12 | 4 exciters on Out 1-4 | 7 piezos on In 1-7 (positions not recorded) | loopback Out 5 → In 8 |
| 10-13 | same 4 | coil currents of the 4 exciters on In 1-4; 3 roving piezos on In 5-7 (placements P0, P1, P2) | current |
| 10-14 morning | 7 exciters E1-E7 on Out 1-7; E1/E2 later moved to Out 9/10 | piezos P1-P8 on In 1-8 (P8 later removed) | loopback Out 8 → In 8 |
| 10-14 evening | E1 → Out 9, E2 → Out 10, E3-E7 → Out 3-7 (Out 1/2 never driven) | coil currents E1-E7 on In 1-7; P8 at E7 on In 8 | none (currents) |

- Board about 1200 × 1000 mm. Positions in mm from the bottom-left of the front, read from a photo (±30 mm, up to ±50 mm at the edges): layout-20261014/board_layout.json.
- The piezos never sat in the same place on two days (checked by measurement). So mode shapes cannot be compared across days; frequencies and damping can.

## 2. What we know about the modes

**Below 200 Hz:** a consensus over 4 full 7 × 7 runs, 18 fits each. "Days" = also found on 10-13 and/or 10-12. "Agreement" = how alike the shape is when seen from different exciters (median MAC; chance about 0.10).

| f (Hz) | Damping % | Confidence | Days | Agreement |
|---|---|---|---|---|
| 32.7 | 2.9 | confirmed | 10-12, 10-13 | 0.24 |
| 53.2 | 4.9 | confirmed, weak | 10-13 (52.2) | 0.22 |
| 62.4 | 3.8 | confirmed | 10-13 | 0.50 |
| 67.6 | 2.9 | confirmed | all three | 0.64 |
| 76.4 | 3.1 | confirmed | all three | 0.42 |
| 80.8 | 3.1 | confirmed | 10-12 | 0.52 |
| 94.9 | 2.5 | confirmed | all three | 0.57 |
| 107.2 | 2.3 | confirmed | all three | 0.47 |
| 109.7 | 2.1 | confirmed | all three | 0.14 |
| 117.6 | 2.9 | confirmed | all three | 0.32 |
| 122.9 | 2.0 | confirmed | 10-14 only | 0.47 |
| 133.0 | 2.4 | confirmed | all three | 0.32 |
| 137.2 | 2.3 | marginal | 10-12 | 0.10 |
| 141.9 | 2.9 | confirmed | all three | 0.18 |
| 145.6 / 152.2 | 2.2 / 2.1 | confirmed | 10-14 only | 0.15 / 0.13 |
| 154.8 | 2.6 | confirmed | all three | 0.19 |
| 159.8 | 2.1 | confirmed | all three | 0.27 |
| 175.1 | 2.4 | confirmed | all three | 0.27 |
| 190.2 | 2.4 | confirmed | all three | 0.20 |

- **Repeatability:** frequencies repeat to about 0.3 %, damping to about 0.2 pp.
- **Shapes** repeat run to run (MAC 0.95), but different exciters see different shapes (0.30). The modes overlap and 7 sensors cannot separate them. That is the main limit, not noise.
- **32.5 Hz** is probably a board mode. For E1, E2 and E3 the peak stays at 32-33 Hz although their own resonances differ (31.8-37.8 Hz). Moderate confidence: one sensor, no force calibration.
- **35-60 Hz:** only 53.2 Hz recurs. 35.6/36.2, 47.8 and 57.9-59.1 Hz (claimed 10-12) are not confirmed. 38.7 Hz is a weak candidate; 48.4 Hz is not supported. The 36-39 Hz peaks are the exciters' own resonances.
- **200 Hz-1.1 kHz:** 43 modes. Frequencies are solid: 48 of 58 match 10-13 within 2 % (median 0.18 %), damping median 1.6 %. Shapes are not reliable (exciter agreement near chance).
  - 204, 206, 223, 233, 253, 259, 264, 276, 297, 317, 321, 344, 377, 384, 402, 418, 526, 542, 550, 580, 600/601, 611, 637, 644, 658, 674, 707, 715, 740, 760, 766, 791, 796, 820, 831, 861, 875, 900, 920, 936, 953, 978, 1011, 1028 Hz.
- **1-2 kHz:** no usable model. Only 1-3 stable poles; about 60-100 modes, which 7 points cannot resolve.
- **Damping:** about 2-3 % below 150 Hz and about 1.6 % from 150 Hz to 1 kHz (the 10-12 free decays agree).

## 3. Exciters and rig: established facts

| Fact | Evidence |
|---|---|
| Exciter suspension resonances at 32-45 Hz (E1 37.8, E2 31.8, E3 34.8, E4 37.6, E5 40.6, E6 37.0, E7 45.0). Below them the drive force falls (a 14 dB shelf below about 31 Hz). | coil admittance, LF runs |
| E2 distorts mechanically (motion 2nd harmonic -16 dB at -36 dBFS), E1 less so. The coil currents are clean, so the amplifiers and the UMC are fine. E2 runs 6 dB lower until it is inspected (10-15). | current vs P8 |
| Out 1/2 went through the UMC MAIN knob (about 13 dB quieter). The "1/2 vs 3/4" difference followed the exciters. | Out 1/2 → 9/10 swap |
| Per volt the exciters differ (Out 3 about +9 dB, mostly current). Per-ampere data removes this. | ladders |
| Superposition holds above 35 Hz (all 7 at once = one at a time, within 0.4-0.6 dB). | multisine |
| Level dependence is small: about 1 dB per 12 dB below 250 Hz, frequencies within 0.15 %. | 3-level 7 × 7 |
| Drift over 1.7 h: about 0.13 % in frequency, 0.4-0.6 dB at LF. | repeats |
| Open: below 30 Hz the 7-exciter multisine and the sweep differ by 10-20 dB. It is not per-exciter stick-slip. | MIMO, B4 |

## 4. Uncertainties

- Only one motion sensor today (P8). The 32.5 Hz verdict and the motion-distortion ranking rest on it.
- Single PolyMAX fits below 200 Hz are unreliable (the same data gave different lists). Only the consensus results above are used.
- No force calibration (per volt, or per ampere), and current is not force near the exciter resonances. There is no calibrated accelerometer, so scaling is relative only and there are no modal masses.
- No shared sensor across days, so shapes are comparable only within a session.
- Positions are ±30-50 mm.

## 5. Problems found

| Problem | Effect | Fix |
|---|---|---|
| Current-sense harness In 1-4 with a shared return (-43 dB crosstalk) | coil currents unusable as extra sensors | separate returns / shielded pairs |
| P8 cable couples into In 5-7 (-41 dB) | same | re-route the P8 cable |
| Weak piezo on In 5 (10-13) | lost points | wiring test before every capture |
| Unequal input gains on 10-13 (up to 20 dB) | biased per-ampere levels for P0/P1 (MAC fine) | equalise gains, probe first |
| E6 dropped out once (10-14) | one wasted run | check connectors |
| D: disk full during a run | one session re-taken | keep ≥ 5 GB free (checked now) |

## 6. Ways forward (priority order)

1. E2 mounting inspection (user, 10-15), then re-run the E2 distortion check.
2. S7 reprocessing (no rig time): convert today's per-volt data to per-ampere with each exciter's measured admittance (all 7 recorded). Re-run the consensus poles and see how much of the exciter disagreement was electrical.
3. S0-S1b (about 1.5 h): calibrate volts and amps, measure the exciter impedances, and use the added-mass method to get the force factor (Bl). This gives per-newton responses and also tests 32.5 Hz (an exciter resonance moves with added mass, a board mode does not).
4. Fix the wiring (current returns, P8 cable) and add inputs: a 2nd UMC over ADAT, or 4 currents + 4 piezos.
5. S3: one piezo next to each exciter, for driving points and reciprocity.
6. Grid: 200 mm (30 points, 5 placements) for < 200 Hz, then 100 mm (about 110 points) for shapes up to about 500-800 Hz. Keep P8 at E7 fixed as the cross-session reference. 1-2 kHz needs a vibrometer or a roving hammer.
7. Standard method: consensus poles; sweeps for reference data; multisine above 35 Hz for fast surveys; a dedicated LF sweep below 35 Hz.

## 7. Process parameters and timing

**Common:** UMC1820 via ASIO in the engine's backend, 48 kHz, buffer 64, 32-bit, 8 inputs recorded (7 for the morning piezo runs). Guards: an input above -6 dBFS steps the level down; above -3 dBFS stops. Levels per exciter: E1/E6 -42, E2 -42 (-48 since decision 3), E3/E5/E7 -36, E4 -30 dBFS. Capture times are measured from the session files; ~ marks analysis times that were not timed.

### 7.1 A full session as run on 10-14

| Stage | Signal | Capture | Analysis | Data |
|---|---|---|---|---|
| Clean stack + backend start + preset (ASIO open) | — | ~1 min | — | — |
| Passive noise record | silence 5-10 s, 8 inputs | 0.2 min | seconds | 15-17 MB |
| Wiring / ID bursts | 1 s chirp 100 Hz-2 kHz per exciter, 3 s apart (+2 s 100 Hz tone variant) | 0.4-0.7 min | seconds | 57-196 MB |
| **Full 7 × 7 ESS** | 20 s ESS 20 Hz-2 kHz (+3 s tail), × 3 per exciter, 21 sessions | **8.8 min** (8.4-8.8 measured, 4 runs) | PolyMAX full band + LSFD + MAC + plots ~3-5 min | 710-790 MB |
| LF ESS | 8 s precheck ramp (-36/-30/-24) + 30 s ESS 15-150 Hz × 3 per exciter | 16 min | ~2 min | 1.3 GB |
| MIMO (all 7 at once) | orthogonal multisines 20 Hz-2 kHz, 4 s period, 7 blocks × 3 periods, 3 realisations | 4.3 min (3 × 85 s) | ~1 min | 680 MB |
| Level ladder | full 7 × 7 at 0 / -6 / -12 dB | 26 min (3 × 8.8) | 3 × PolyMAX + comparison ~10 min | 2.1 GB |
| Nonlinearity ladder | 8 s ESS 20 Hz-10 kHz + 4 tones, 3-5 levels × 4 exciters | 3.3-6 min | ~2 min | 250-440 MB |
| B2 exciter admittance (LF) | 20 s ESS 15-200 Hz × 2 per exciter | 5.7 min | <1 min | 610 MB |
| B3 current vs motion distortion | 8 s ESS 20 Hz-5 kHz + 3 tones, 2-3 levels × 5 exciters | 3.6 min | <1 min | 330 MB |
| B4 sweep vs multisine (LF) | 20 s ESS + 2 × multisine (16 s), 4 exciters | 4.0 min | <1 min | 380 MB |
| **Consensus poles < 200 Hz** | 18 PolyMAX fits per run (3 band sets × 2 orders × 3 bootstrap) | — | **190 s per run** (measured); 4 runs + LF = **16 min** | small |
| 1-2 kHz PolyMAX probe | 3 settings | — | >10 min (measured) | small |

### 7.2 Totals

| Session | Rig time | Analysis | Wall-clock |
|---|---|---|---|
| **Minimum useful:** wiring check + one full 7 × 7 + fit | ~11 min | ~5 min (single fit) | ~20 min |
| **Minimum trustworthy below 200 Hz:** 3 × full 7 × 7 + consensus | ~28 min | ~16 min | **≈ 45 min** |
| **10-14 full program** (13:15-18:40) | ~2 h capture | ~1 h computation | ~5.5 h, incl. ~2 h waiting for decisions and re-wiring |

### 7.3 Earlier days

| Day | Stage | Capture | Data |
|---|---|---|---|
| 10-12 | linearity (3 levels × 4 exciters, 8 s ESS) | 2.2 min | 230 MB |
| 10-12 | sweep speed (8/30/60 s ESS × 4 + noise) | 9.5 min | 820 MB |
| 10-12 | swept discovery (coarse 20 s + fine zones, 3 repeats) | 8.2 min | — |
| 10-12 | stepped sine E1 / E2 (< 200 Hz) | 26 / 16.5 min | 2.4 / 1.5 GB |
| 10-12 | chirp collection (4 × 5 × 11.5 s) + ESPRIT | ~4 + 1 min | — |
| 10-13 | **one roving placement** (3 × 20 s ESS × 4 exciters, 3 piezos) | **4.8 min** capture + user re-patching (placements were 40-60 min apart, incl. discussion) | 410 MB |

### 7.4 Planned sessions

| Session | Content | Rig time | User work |
|---|---|---|---|
| S0 | volt and amp calibration | 20 min | meter at the amplifier, resistor or clamp |
| S1 | exciter impedances 15 Hz-5 kHz | 10 min | — |
| S1b | added mass, 2 masses per exciter | 30-45 min | attach masses |
| S2 | 2nd UMC over ADAT, sync check | 15 min | optical cable, clock settings |
| S3 | piezo at each exciter (driving points) | 15 min | ~15 min gluing |
| S5 | 200 mm grid, 30 points | 5 × 8 min | 5 × ~5 min re-patching |
| S6 | 100 mm grid, ~110 points | ~16 × 8 min ≈ 2.2 h | 16 × ~5 min |
| S7 | per-ampere reprocessing | none | none (~30 min computation) |

### 7.5 What takes the time and how to cut it

- **Capture:** the 20 s ESS × 3 × 7 (8.8 min per 7 × 7) dominates. MIMO above 35 Hz (4.3 min) plus a short LF sweep roughly halves it; 2 repeats instead of 3 saves another third, at the cost of the noise estimate.
- **Analysis:** the consensus fits (190 s per run) dominate. They are independent and can run in parallel: 16 min becomes ~4 min on 4 cores.
- **Wall-clock:** dominated by decisions and re-wiring, not by measuring. Fixing the wiring and inputs once and agreeing the session plan in advance removes most of the idle time.
