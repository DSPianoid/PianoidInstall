# Swept-sine mode discovery (coarse + fine, FRF / CMIF / MAC)

**Status:** IMPLEMENTED on branch, awaiting review (dev-69fd, 2026-10-11) — Core `feature/dev-69fd-swept-discovery`.
**Request (user, 2026-10-11):** "new mode discovery procedure: swipe the frequency over each exciter
and find matching maximums of the response amplitude and MAC. Make one raw swipe to define zones of
interest and then fine swipe to find exact frequencies. Take reasonable defaults and criteria".

## 1. Procedure

```
noise record (all receivers, 2 s)                      -> noise floor per receiver
COARSE: for each exciter e in Out 1..4                 -> one /audio/session play_record
          exponential sine sweep 20 Hz..10 kHz          (In 1..7 + loopback In 8)
        -> H(f) in C^{7 x 4} on a 0.25 Hz grid
        -> CMIF sigma1/sigma2(f) + per-exciter sum_k |H_k|^2
        -> peaks (prominence, SNR) that are MAC-consistent -> ZONES
FINE:   for each exciter: ONE session = concatenated narrow linear sweeps, one per zone
          (only zones where this exciter's coarse SNR is useful), silent gap after each
        -> H(f) per zone on a fine grid (step <= half-power bandwidth / 10)
        -> polyreference rational fit per zone (poles shared by all exciters)
        -> f, zeta, complex shape over receivers, participation per exciter, MAC, SNR
COMBINE: dedupe across zones (frequency + MAC); per-exciter refits give the cross-exciter spread
OUTPUT:  report.json, modes.npz (ESPRIT/tracking per-scenario format), plots
```

Audio I/O exclusively through the ASIO measurement session (`POST /audio/session` on `:5000`,
[REST_API.md](../modules/pianoid-middleware/REST_API.md#post-audiosession)); synthesis is paused by
the session. The module calls it through a one-method adapter (`play_record`) so the AudioIO
protocol of the sdl→ASIO migration can replace it without touching the analysis.

## 2. Excitation choices

| Pass | Signal | Why |
|---|---|---|
| Coarse | **Exponential sine sweep (Farina)**, 20 Hz–10 kHz, 8 s, ±1/4-octave cos fades, **−30 dBFS** peak | One session covers the whole band; pink energy distribution (more energy at LF where the soundboard is least efficient); harmonic distortion products land at *negative* time after deconvolution and are windowed out — linear FRF is clean even if the exciter amp/transducer is slightly nonlinear |
| Fine | **Narrow linear sweep per zone** (zone ± 0, flat energy per Hz), 1 s per zone, Tukey 10 %, −30 dBFS, followed by a silent gap ≥ 5 τ (τ = 1/(2π ζ f), clamped 0.3–2 s) | All the sweep energy goes into the zone (≫ SNR per Hz than the broadband pass); deconvolution makes the FRF exact for any sweep rate (no quasi-stationary sweep-rate error), so no slow stepped-sine settling is needed; zones are batched into one session per exciter (≤ 110 s per session, split otherwise) |

Stepped sine was rejected: each step needs ≥ 5 τ settling (≈ 2 s at 20 Hz, ζ = 2 %), i.e. minutes per
zone, for no accuracy gain over a deconvolved sweep. Multi-exciter simultaneous sweeps (MESM) were
rejected for v1 — sequential exciters are simpler and keep each session's crest factor low.

**Reference / timing.** The digital sweep is the excitation reference; the session's loopback marker
(Out 5 → In 8, marker 0.25 FS) gives the measured round trip and `compensate_latency: "loopback"`
aligns the capture to it. Out 5 is **not** driven with the sweep: the rig's Out 5 → In 5–7 crosstalk
is only ~33 dB below the loopback and would corrupt receivers 5–7. A common converter delay/phase
does not affect MAC, |H| peaks or the fitted poles.

**Levels.** Default −30 dBFS; configurable; > −20 dBFS logs a warning and > −12 dBFS is refused.

## 3. Analysis and criteria (defaults)

| Stage | Criterion | Default |
|---|---|---|
| Coarse FRF | regularised deconvolution `H = Y X* / (|X|² + ε)` (ε weak over the sweep range 20 Hz–10 kHz, not at the analysis-band edges), IR window [−min(0.1 s, ½ ESS 2nd-harmonic advance), 2.5 s] | IR window 2.5 s (decay ≥ 40 dB for ζ ≥ 0.6 % at 50 Hz), 0.25 Hz grid, analysis band 30 Hz–9.5 kHz |
| Noise floor | `|N(f)|² / |X(f)|²` from a 2 s silent record | — |
| Indicator | CMIF σ1(f) (largest singular value of the 7 × 4 FRF matrix); σ2 reveals close / repeated modes | — |
| Peak | prominence of 20 log σ1 | ≥ 3 dB |
| | SNR (σ1² vs noise σ1²) | ≥ 10 dB |
| MAC consistency | MAC(u1(f_p), u1(f_p ± B/4)) — shape stable over the peak | ≥ 0.80 |
| Duplicate merge | adjacent peaks closer than the larger half-power bandwidth with MAC ≥ 0.95 | merged |
| Extra pole | σ2 peak within B of a σ1 peak, ≥ 3 dB prominent, σ2/σ1 ≥ −30 dB | +1 pole (close / repeated mode) |
| Zone | one LOCAL zone per group of peaks (peaks closer than the larger half-power bandwidth B form a group = close / repeated modes): [f − 2.5 B, f + 2.5 B], B = measured σ1 half-power width (clamped to [2 grid bins, 0.1 f]); other peaks inside the zone are fitted as context poles | ≤ 150 zones (by SNR) |
| Core ownership | each zone OWNS [midpoint to the previous group, midpoint to the next group); the zone always covers its core + B/2; a pole is accepted only in its zone's core → overlapping zones give no duplicates and no gaps | — |
| Fine grid | step ≤ B/10, ≥ 41 and ≤ 600 points per zone | — |
| Fine per exciter | sweep a zone with exciter e only if e's coarse SNR there | ≥ 6 dB |
| Fit seeds | coarse peaks (+ σ2 extra poles) of the zone and its context, **plus fine-grid CMIF σ1/σ2 peaks** (prominence ≥ 1 dB — the fine data have far more SNR per Hz) not within B/2 of an existing seed | ≤ 12 poles per zone |
| Fit | polyreference rational model `H_ke = Σ_m R_m,ke/(jω−λ_m) + A_ke + B_ke jω/ω0` (conjugate poles / out-of-zone modes absorbed by A, B), poles by variable projection (`scipy.optimize.least_squares` over f, log ζ), residues linear, columns noise-weighted | then ≤ 2 extra poles, one at a time at the largest residual, each kept only if the residual drops ≥ 25 % and all poles stay physical |
| Physical pole | 1e-4 < ζ < 0.2, f inside the zone | — |
| Mode accept | best-exciter SNR ≥ 10 dB and fit MAC (measured vs model vector at f) ≥ 0.9 | — |
| Shape | residue matrix R_m (7 × 4) → SVD: shape ψ (7), participation L (4); rank-1 ratio σ2/σ1 reported | — |
| Cross-zone dedupe | \|Δf\|/f < max(0.5 ζ, 0.1 %) and MAC ≥ 0.9 | keep higher SNR |
| Cross-exciter spread | single-reference refit per exciter (initialised from the joint poles) | f / ζ spread reported |

The reported frequency is the **natural frequency** |λ|/2π (as ESPRIT); the fine-grid amplitude
peak is reported alongside.

## 4. Outputs (`D:\modal_measurements\swept_discovery\<run_id>\`)

- `report.json` — config, timings, session ids / levels / xruns, zones, modes
  (`f_hz, zeta, f_peak_hz, shape[7] complex, participation[4], best_exciter, snr_db, mac_fit,
  rank1_ratio, per_exciter {f_hz, zeta, mac}`).
- `modes.npz` + `per_scenario` block — one scenario per exciter in the ESPRIT/tracking format
  (`frequencies, damping_ratios, mode_shapes (n_modes × 7 complex) = R[:, e], poles, amplitudes`),
  consumable by `EspritRunner._build_all_detections` → tracking → feedin → Apply.
- Plots: `coarse_cmif.png` (σ1/σ2, noise, peaks, zones), `fine_zones_*.png` (measured vs fit),
  `mac_matrix.png` (AutoMAC of the final modes).
- `sessions/` — raw session folders (`data.npy`, `meta.json`) written by `/audio/session`.

## 5. Entry points

`python -m pianoid_middleware.modal_adapter.swept_discovery run [--exciters ...] [--level-dbfs -30] ...`
(rig) and `... synth` (offline simulation on a known modal plant). No UI in v1.

## 6. Validation plan

1. Offline: simulated plant (ZOH modal oscillators, `synth.oscillator`) with known modes incl. a
   close pair and a near-repeated pair excited by different exciters, + noise → frequency error
   < 0.1 %, ζ error < 10 %, no duplicates. Unit tests on synthetic FRFs (deconvolution, CMIF/zones,
   MAC, fit).
2. Rig: coarse + fine for Out 1–4; mode count / range; repeatability (re-run fine on a few zones);
   total time; comparison with the preset's ESPRIT modes only where the soundboard is confirmed the same.

## 7. Validation results (dev-69fd, 2026-10-11)

**Offline (simulated plant, exact ZOH modal oscillators, 7 receivers × 4 exciters).**

| Plant | Result |
|---|---|
| Demo plant (12 modes 55 Hz–6.5 kHz, ζ 1–2 %, close pair 400/404 Hz, near-repeated pair 1100/1102 Hz on disjoint exciters), noise 3e-4 | 12/12, no duplicates; f error ≤ 0.005 %, ζ error ≤ 1.4 %; the 1100/1102 pair attributed to the right exciters |
| Dense random plant (42 modes 40 Hz–4 kHz, ζ 0.5–3 %, + 777.0/777.4 Hz pair on disjoint exciters), noise 1e-4 | 38/42 matched, 0 spurious; 36 within 0.1 % f and 10 % ζ; the misses / ζ outliers are all pairs closer than one half-power bandwidth (40.7/41.0, 81.5/83.7, 426.9/428.4 Hz, 777.0/777.4 Hz = 0.05 % apart) |
| Same, noise 1e-3 | 36/42 matched, 1 spurious |
| `pytest tests/unit/test_swept_discovery.py` | 15/15 (f < 0.1 %, ζ < 10 % on single + close-pair fits and end-to-end) |

**Rig (UMC1820, Out 1–4 → In 1–7, loopback Out 5 → In 8, −30 dBFS, user stack running; run
`D:\modal_measurements\swept_discovery\20261011-rig3`).**

| Item | Value |
|---|---|
| Sessions | 9 (noise, 4 coarse, 4 fine), all `ok`, 0 xruns, loopback onset 328 frames in every session; synthesis resumed (`PLAYBACK_ACTIVE`) |
| Noise floor | −78…−85 dBFS rms per receiver; mode SNR 18–88 dB (median 77) at −30 dBFS — no level increase needed |
| Coarse | 23 CMIF peaks → 23 zones |
| Modes | **70 accepted, 33–6283 Hz** (20 < 250 Hz, 23 in 250–1000, 11 in 1–2 kHz, 14 in 2–6.3 kHz); ζ 1.3–15 %, median 3.2 %; fit MAC ≥ 0.966 (median 0.994); best exciter Out 3 (30), Out 4 (28), Out 2 (12) |
| Shape consistency | residue-matrix rank-1 ratio σ2/σ1 median 0.45 — high modal overlap: above ~250 Hz several modes share a half-power bandwidth, so per-exciter single-reference refits disagree more than the joint fit |
| Repeatability (3 extra fine passes on the 6 strongest zones, 25 modes) | f spread median 0.15 % (isolated modes 0.002–0.06 %, e.g. 976.3 Hz ±0.007 Hz std), max 1.3 %; ζ spread median 4.3 %, max 49 % (overlapped high-ζ modes) |
| Time | discovery 233 s (noise 12, coarse 50, fine 138, fit 33); repeatability 151 s; total wall 388 s |

Earlier rig iterations (same session): merged ±3B zones chain-merged into 7 giant zones and lost
coarse peaks (→ local zones + core ownership); 2 extra poles left real fine-grid peaks unmodelled
(→ fine-grid seeding). The Belarus preset's ESPRIT modes were **not** compared: the docs do not
identify the rig soundboard as the Belarus instrument (the only Measurement on the rig is the
PlyWood "LG" set), so the comparison would be meaningless until the rig board is confirmed.
