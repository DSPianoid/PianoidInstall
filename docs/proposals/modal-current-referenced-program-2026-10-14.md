# Current-referenced modal measurement program (2026-10-14)

**Status:** proposal (plan only). Agent dev-fd69.
**Basis:** the rig sessions of 2026-10-13/14 (session log `docs/development/logs/dev-fd69-2026-10-11-165927.md`), in particular the first current-sense runs B1–B4 of 2026-10-14.
**Purpose:** use the exciter **coil currents** as the reference, instead of the drive voltage, and extend the sensing to many board points. The aim is a modal model of the soundboard (frequencies, damping, shapes and, if possible, scaling) that does not depend on the amplifiers or the exciters.

---

## 1. Where we are

**The rig:**
- 7 voice-coil exciters, wired E1 → Out 9, E2 → Out 10, E3–E7 → Out 3–7. Out 1/2 are monitor-only and never driven.
- UMC1820 ASIO session on `:5000`.
- Inputs today: In 1–7 are the coil currents of E1–E7, and In 8 is piezo P8, collocated with E7.
- There is no loopback. The coil currents are the timing reference.

**Established by measurement** (details in the session log):

| Finding | Evidence |
|---|---|
| Per-volt FRFs carry large exciter/amplifier differences: Out 3 drives about 9 dB more per volt, Out 9/10 about 13 dB more than Out 1/2 did | 10-13 / 10-14 ladders and probes |
| Exciter distortion is **mechanical**: the coil currents are clean (H2 at the noise floor, ≤ −50 dB) while the motion H2 at P8 grows with level. **E2 is the worst** (−16 dB motion H2 at −36 dBFS) | B3 |
| Every exciter has a suspension resonance at **32–45 Hz** (admittance minimum): E1 37.8, E2 31.8, E3 34.8, E4 37.6, E5 40.6, E6 37.0, E7 45.0 Hz | B2 |
| The **32.5 Hz** P8 peak is fixed for E1/E2/E3 although their fs differ, so it is likely a **board mode**. The 36–38 Hz features for E4/E6 coincide with their own fs and are exciter resonances | B2 |
| Below 250 Hz the per-volt FRF changes about 1 dB per 12 dB of drive, and mode frequencies shift ≤ 0.15 % (≈ drift) | 7 × 7 ladder |
| Superposition (all 7 exciters at once, MIMO) holds above 35 Hz within 0.4–0.6 dB | MIMO vs ESS |
| Single-exciter ESS vs multisine below 30 Hz: **no** 10–20 dB discrepancy in I/V, P8/V or P8/I. The gap seen in the 7-exciter MIMO run is not per-exciter stick-slip | B4 |
| Below 200 Hz, single PolyMAX fits are not repeatable. The **consensus pole set** (multi-run + bootstrap) is required. It gives 20 poles, cross-exciter MAC 0.30, shape repeatability 0.95 | consensus run |
| 7 sensor points cannot resolve 1–2 kHz (spatial aliasing) | 1–2 kHz analysis |

## 2. What per-ampere FRFs answer that per-volt FRFs cannot

1. **They remove the amplifier channels and outputs.** Out 3's +9 dB, the hot line outs Out 9/10, amplifier-gain mismatches and any re-patching of outputs drop out. FRFs from different sessions and different exciters become directly comparable. A per-volt comparison across exciters mixes the electrical gain into the "participation".
2. **They remove most of the level dependence that sits in the drive chain.** The current is linear (B3), so per-ampere data isolates what the board and the exciter mechanics do.
3. **They make the force reference explicit.** Above about 2 × fs (≳ 80–90 Hz) the force an inertial exciter applies is close to Bl·I. Below that, the exciter's own transmissibility T(ω) shapes it. T(ω) can be modelled from the admittance fit, giving F = Bl·T(ω)·I (§4). Without the current, that correction is impossible.
4. **They are latency-free.** Ratios such as P/I cancel the interface round trip, so no loopback is needed.
5. **They make reciprocity and driving-point scaling possible** (§6). Both need a force-like reference at the drive point.

Per-ampere FRFs **do not** remove the exciter's mechanical resonance or its mechanical nonlinearity. Those sit after the current. B2/B3 already show this, and §4 handles it.

## 3. Reprocessing existing data

| Dataset | Current channels? | What can be done |
|---|---|---|
| 10-13 roving P0/P1/P2, `frf4ref`, driving point (In 1–4 = coil currents of the then Out 1–4) | **yes** (4 exciters) | Already current-referenced in `rove_analyse.py` (`--ref I`). **P2 is the only one with equalised current gains.** P0/P1 per-ampere magnitudes carry the ~4.5 dB In 1 vs In 2–4 gain error; their MAC is unaffected. Recompute the consensus poles on P0+P1 per ampere. |
| 10-14 morning 7 × 7, LF, MIMO, ladder 0/−6/−12 (piezos on In 1–7, no currents) | no | **Pseudo-current-reference**: multiply each per-volt FRF by the measured V/I of the same exciter. This is valid because the electrical chain was unchanged from 14:36 (E1/E2 on Out 9/10) to the B-runs, and the current is linear and repeatable (B2 repeats agree). B2 covers 15–200 Hz for all 7 exciters; B3 covers 20 Hz–5 kHz for E1/E2/E3/E4/E7. **Gap:** a 20 Hz–2 kHz admittance for E5/E6 (session S1 adds it). |
| 10-14 B1–B4 (In 1–7 currents, In 8 = P8) | **yes** (7) | Native per-ampere data; P8 is the only motion point. |
| 10-12 runs (7 piezos, 4 exciters, per volt) | no | Different exciter numbering and outputs, and the amplifier gains were not recorded. Keep per volt. Use them only for frequency/damping comparison. |

Reprocessing is analysis only. A script would apply `H_per_A(f) = H_per_V(f) · V/I(f)` per exciter, re-run the consensus procedure, and compare cross-exciter MAC per volt vs per ampere. **Expectation:** the cross-exciter MAC rises wherever the per-volt differences were electrical gain or phase. It does not rise where the disagreement is modal overlap.

## 4. Force calibration: from per-ampere to per-newton

The exciters are **inertial**: a moving reaction mass sits on a suspension, and the coil acts between the reaction mass and the board. The force on the board is

`F(ω) = Bl · I(ω) · T(ω)`, with `T(ω) = −ω² M / (K − ω² M + jωC)`.

T(ω) → 1 well above fs. It peaks at fs and rolls off as (f/fs)² below fs. That roll-off is the LF shelf below about 31 Hz.

**Estimating the exciter parameters** (per exciter, ≈ 10 min each), Thiele–Small style:
1. **Calibrate the electrical scale once** (session S0). Measure:
   - the amplifier output voltage at a known dBFS level (1 kHz sine, true-RMS meter at the amplifier terminals);
   - the current-sense scale (A per dBFS), by passing a known current through a known resistor, or with a clamp meter.

   This turns I/V into ohms.
2. **Impedance Z(f) = V/I** with the exciter mounted on the board: Re (the DC/low-f plateau), fs, Qes and Qms from the motional peak. B2 already gives the shape and fs. S0 gives the scale.
3. **Added-mass method:** fix a known mass Δm (e.g. 10–20 g) to the **reaction mass** (the moving body). Re-measure fs → fs'. Then `M = Δm / ((fs/fs')² − 1)`, `K = (2π fs)² M`, and `Bl = sqrt(2π fs · M · Re / Qes)`.
4. **Cross-check:** a blocked-reaction-mass measurement (if mechanically possible) gives the blocked inductance and Re. Compare Bl from two different added masses.

With Bl and T(ω), **F/I** follows, and every per-ampere FRF becomes **per newton**. The P8 driving-point FRF at E7 then becomes a true accelerance-like driving point. The scale is still relative until P8 itself is calibrated (§6).

## 5. Sensor strategy: board motion at many points

**Constraint:** each measured point needs one input. Today 7 inputs carry currents and only 1 carries a piezo (P8).

**Options:**

| Option | Inputs | Exciters with force reference | Motion points per placement | Effort / risk |
|---|---|---|---|---|
| A. 4 currents + 4 piezos on the main UMC | 8 | 4 (e.g. E1–E4, or the 4 best-placed) | 4 (1 fixed reference + 3 roving) | re-patching only; the other 3 exciters are idle or voltage-referenced |
| **B. 2nd UMC1820 over ADAT (recommended)** | 16 | **7** | **8** (P8 fixed at E7 + 7 roving) | optical cable; the 2nd unit is set to 48 kHz ADAT out, and the main UMC clocks from it (or both from word clock). **Verify sample lock first** (S2). |
| C. Today's layout (7 currents + P8) | 8 | 7 | 1 | no motion grid; useful only for the exciter characterisation done in B2/B3 |

**B is recommended.** It keeps all 7 force references and gives 7 roving points per placement plus one fixed reference.

**Clock risk:** if the two units are not sample-locked, cross-unit FRFs (piezo on unit 2 / current on unit 1) drift in phase. **Test:** split one signal into both units and verify zero drift over 120 s.

**Grid density** (board about 1200 × 1000 mm, user 2026-10-14; frame in §10, decision 4).
- The bending wavelength is estimated from the measured mode density n(f) ≈ 0.05–0.1 modes/Hz (200 Hz–1 kHz) via `λ ≈ sqrt(π S / (f n))`.
- The plate area is S ≈ 1.08 m² (1.2 × 1.0 m, minus the rounded outline).

| Band | λ | Spacing for 3 points/λ | Grid (whole board) | Placements at 7 roving |
|---|---|---|---|---|
| < 200 Hz | ≥ 410–580 mm | 140–195 mm → **200 mm** | 6 × 5 = **30** | 5 |
| ~500 Hz | 260–370 mm | 87–123 mm → **100 mm** | 12 × 10 ≈ **110** (corners cut) | ~16 |
| 1 kHz | 180–260 mm | 60–87 mm → **75 mm** | 16 × 13 ≈ **190** | ~27 |
| 2 kHz | 130–180 mm | 43–61 mm → **50 mm** | 24 × 20 ≈ **450** | ~65 (impractical with piezos; use a scanning laser vibrometer or a roving hammer + fixed sensors) |

**Practical plan:**
- A **200 mm grid**: points at x = 100…1100 and y = 100…900 mm, 6 × 5 = 30 points, 5 placements. Good to about 180 Hz at 3 points/λ.
- Then a **100 mm grid** (≈ 110 points, about 16 placements): good to about 500 Hz at 3 points/λ, and about 800 Hz at 2 points/λ.
- Coordinates are recorded in mm in the board frame of §10 (origin bottom-left, front side). The positions are marked with a ruler; the photo-derived positions carry about ±30 mm uncertainty.

**Per-placement capture:**
- **MIMO** (all 7 exciters, orthogonal multisines, 3 realisations, about 4.5 min) for speed above 35 Hz.
- Plus an **LF ESS (15–150 Hz, 20 s, 7 exciters one at a time, about 3 min)** below 35 Hz, where MIMO and ESS disagreed.
- Total about 8–9 min plus re-patching (~5 min) per placement.

## 6. Driving points, reciprocity and scaling

**Driving-point FRFs** need a motion sensor collocated with each exciter, as P8 is with E7.
- With option B: run **one dedicated placement** with 7 piezos, each glued next to its own exciter (P_k at E_k).
- That gives the full 7 × 7 matrix of collocated piezo / current FRFs, including 7 driving points.

**Scaling:**
- For mode r the driving-point residue is `A_kk,r = φ_k,r² / m_r`, where φ_k,r is the mode shape at drive point k and m_r the modal mass.
- With a force reference (Bl·T·I, §4) and a **calibrated** motion sensor this gives the modal mass, and **mass-normalised shapes** at all drive points.
- The roving points are then scaled through the shared modes.
- **Piezos are not calibrated.** Options:
  - **(a)** one calibrated accelerometer, roved through the 7 drive points once (7 short captures);
  - **(b)** calibrate each piezo in place against that accelerometer (side by side, same location).

  Without a calibrated sensor, shapes and relative scaling are still obtained; absolute modal mass is not.
- **Decision 2 (2026-10-14): no calibrated accelerometer is available. The program uses relative scaling only.** S4 is dropped. Mode shapes are unit-normalised. Driving-point residues are compared in relative terms only (ratios between modes and exciters), and no absolute modal masses are produced.

**Reciprocity check:**
- With collocated sensors at exciters i and j (same sensor type, force-referenced), `H_ij = H_ji` should hold.
- Test all 21 pairs per band. Report the deviation (dB, degrees) as the data-quality metric for the whole force/sensor chain.
- Expected limits: piezo-calibration mismatch, which cancels in the ratio with the calibration step of (b); and T(ω) errors below about 2 fs.

## 7. The 32 Hz / LF questions

**From B2:**
- 32.5 Hz behaves as a board mode: a fixed frequency across exciters whose fs differ (31.8–37.8 Hz).
- 36–38 Hz (E4, E6) are exciter suspension resonances.

**Confirmation in the program:**
1. **Per-newton LF FRFs** (§4 correction): the exciter resonances flatten in F-referenced data, and a board mode stays.
2. **The grid placements (§5) give the 32.5 Hz shape.** A board mode has a smooth, exciter-independent shape over the grid. An exciter resonance shows up as local motion around the resonating exciter.
3. **Added-mass check:** adding Δm to one exciter's reaction mass shifts that exciter's fs (by ~(1 + Δm/M)^−½) but **not** a board mode. One session, two masses, P8 + the grid sensors.
4. The consensus procedure gives the LF poles with their spread. The LF band uses the dedicated 15–150 Hz ESS and the growth-based distortion guard.

## 8. Standard procedures (all sessions)

- **Pole sets:** use the consensus procedure (multi-run + bootstrap + settings grid, `dev-fd69-consensus-lt200-2026-10-14.py`). Never report a single PolyMAX fit below 200 Hz.
- **Excitation:**
  - ESS for reference FRFs and harmonic separation;
  - MIMO orthogonal multisines for fast surveys above 35 Hz, with a direct estimate of the nonlinear-distortion variance;
  - the LF ESS (15–150 Hz) for < 35 Hz.
- **Levels:** guard −6 dBFS on any input and stop at −3 dBFS. Ceilings: E1/E2 (Out 9/10) ≤ −36 dBFS, others ≤ −30. **E2 is mechanically nonlinear** (decision 3): until its mounting is inspected (planned 2026-10-15), every capture drives E2 **6 dB below its planned level**.
- **Session-to-session reference:**
  - keep **P8 at E7 fixed** for the whole program;
  - every placement includes E7 → P8 (per ampere) as the drift/consistency check;
  - flag a session if its 25 Hz–1 kHz |Δ| vs the first session exceeds 0.5 dB median, or if the 107 / 133 / 159.8 Hz poles move by more than 0.2 %.
- **Metadata:** `run_config.json` per run, with the output/input map, levels, the alignment strategy and placement coordinates.

## 9. Session plan

Durations are rig time, plus the user's re-patching. "User" means a physical action by the user.

| # | Session | Wiring (user) | Drive / levels | Duration | Outputs |
|---|---|---|---|---|---|
| S0 | Electrical calibration | **User**: true-RMS meter on one amplifier output; known resistor or clamp for the current-sense scale | 1 kHz sine, −30 dBFS, per output (Out 3–7, 9, 10) | 20 min | V per dBFS per output; A per dBFS per current channel → impedance in Ω |
| S1 | Exciter characterisation | as now (7 currents + P8) | per exciter: ESS 15 Hz–5 kHz, −42 / −36 dBFS (E1/E2 −42) | 10 min | Z(f) per exciter, fs, Qes, Qms; fills the E5/E6 broadband V/I gap for reprocessing (§3) |
| S1b | Added mass | **User**: attach Δm1 (≈ 10 g), then Δm2 (≈ 20 g), to each reaction mass in turn (or to 3 representative exciters) | ESS 15–200 Hz per exciter per mass, −36 dBFS | 30–45 min | M, K, Bl per exciter; the T(ω) model; the 32.5 Hz added-mass test (§7.3) |
| S2 | 2nd UMC over ADAT | **User**: optical cable + clock config; split one test signal into both units | 120 s tone/noise into both units | 15 min | sample-lock verification (no drift) |
| S3 | Driving-point placement | **User**: 7 piezos, one next to each exciter, on unit 2 (P8 stays at E7) | ESS 7 × 3 (20 Hz–2 kHz, today's levels) + LF ESS | 15 min + 15 min patching | 7 × 7 collocated matrix, driving points, reciprocity (21 pairs) |
| S4 | Calibrated accelerometer — **dropped (decision 2)** | **User**: roving accelerometer at the 7 drive points | short ESS per position | 20 min | piezo calibration factors → mass-normalised shapes |
| S5 | LF grid, 6 × 5 = 30 points | **User**: 7 roving piezos, 5 placements, coordinates in cm | per placement: MIMO 4.5 min + LF ESS 3 min | 5 × (8 + 5) ≈ 65 min | < 200 Hz shapes on 30 points + 7 drive points; the 32.5 Hz shape |
| S6 | Mid grid, ≈ 100 points | as S5, 10 more placements | as S5 | ≈ 2.2 h (can be split across days) | shapes up to ~600–700 Hz |
| S7 | Reprocessing (analysis only) | — | — | — | §3 per-ampere re-reference of 10-13/10-14 data; consensus poles per ampere vs per volt |

**Per session the analysis delivers:**
- consensus poles (frequency, damping, spread);
- cross-exciter MAC per ampere / per newton;
- AutoMAC;
- board-map shapes;
- reciprocity (S3);
- the drift check against the fixed P8.

**Total rig time:** about 5–6 h, plus patching. S0–S3 (about 2 h) answer the force/scaling and 32 Hz questions. S5–S6 build the shape grid.

## 10. User decisions (2026-10-14)

1. **Keep the installed setup today** (In 1–7 = coil currents of E1–E7, In 8 = P8 at E7; no 2nd interface). The exciters have not moved since the morning, so the morning 7 × 7 piezo FRFs (P1–P7) count as known.
   - The coil currents are to be tried as **7 additional response points** (back-EMF at each exciter location).
   - The B1–B3 feasibility analysis says this is mixed: the In 1–4 harness carries instantaneous crosstalk (about −40 dB), In 5–7 track the P8 line, and only an LF residue (≲ 200 Hz) is partly reciprocal.
   - One broadband 7 × 7 capture is planned as the decisive test (session log, 2026-10-14 evening).
   - Options A/B of §5 remain the route to a motion grid on a later day.
2. **No calibrated accelerometer:** relative scaling only (§6). S4 is dropped.
3. **E2 is used as is, 6 dB below the planned levels;** the user inspects its mounting on 2026-10-15.
4. **Board about 1200 × 1000 mm.** Frame:
   - x = 0–1200 mm left → right, y = 0–1000 mm bottom → top;
   - origin at the bottom-left of the board outline as seen in the photo (front/piezo side);
   - the exciters are on the reverse at the same (x, y), with nothing mirrored.
   - `layout-20261014/board_layout.json` now carries `piezos_green_mm` / `exciters_red_mm`, alongside the normalised photo coordinates (where y ran top → bottom).
   - **Uncertainty about ±30 mm** (up to about ±50 mm near the edges). The photo outline aspect was 1.30 against the stated 1.20, a perspective and outline-reading error.
   - Shape plots use mm axes (`dev-fd69-replot-shapes-mm-2026-10-14.py`; fixed-layout and LF analyses).

**Still open:** option A vs B for the motion grid on a later day, and whether to run the reprocessing (S7) first.
