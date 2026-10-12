# Modal identification with attached exciters — rig checks, PolyMAX, chirp-ESPRIT, comparison (2026-10-11)

**Status:** implemented, validated offline (2026-10-11) AND on the rig (2026-10-12, tests 1–6 of
[§7](#7-rig-test-plan-pending-the-users-go); results [§8](#8-rig-results-2026-10-12)) — dev-fd69, Core
`feature/dev-fd69-modal-methods`, Tunner `feature/dev-fd69-chirp-ui`, both unmerged.
Code reference: [MODAL_COLLECTION → Excitation types](../modules/pianoid-middleware/MODAL_COLLECTION.md#excitation-types-impulse-train-vs-chirp-dev-fd69)
and [→ Swept-sine discovery, PolyMAX and method comparison](../modules/pianoid-middleware/MODAL_COLLECTION.md#swept-sine-discovery-polymax-and-method-comparison-dev-69fd-dev-fd69).

**Rig:** UMC1820; exciters Out 1–4 (voice-coil, attached to the board); receivers In 1–7 =
piezoelectric contact sensors on the board; loopback Out 5 → In 8 (timing marker only).
**Data re-analysed:** swept runs `D:\modal_measurements\swept_discovery\20261011-rig{1,2,3}` (8 s ESS
20 Hz–10 kHz per exciter at −30 dBFS, three repeats ~11 min apart), impulse-ESPRIT project
`ASIO-rig-2026-10-11b_p1`. Script `docs/development/diagnostics/dev-fd69-offline-analysis.py`;
outputs + plots `D:\modal_measurements\analysis\dev-fd69-2026-10-11\` (`comparison.log`,
`rig_checks_offline.json`, `modes_per_exciter_by_method.png`, `consistency_by_band.png`,
`cross_method_vs_chance.png`, `polymax\<run>\stabilization.png`).

## 1. Rig checks from the existing recordings

| Check | Result |
|---|---|
| **Repeatability** (coherence `|mean H|²/mean|H|²` over rig1/2/3) | γ² ≥ 0.9996 in every band (p10); repeat SNR 42–48 dB (noise SNR 54–64 dB). The FRFs are stable and the board is time-invariant at this level. |
| **Shape inconsistency in raw data** (σ2/σ1 at CMIF peaks) | 0.31 (<250 Hz), 0.40 (250–1k), 0.53 (1–2k), 0.49 (2k+) — identical in all three runs. Together with γ² ≈ 1 this is NOT noise or drift: several modes share each peak (high modal overlap) and/or the response is not a low-rank modal sum. |
| **Harmonic distortion** (ESS harmonic IRs, 150 ms windows, vs a deconvolved noise record) | Out 3: **H2 −24 dB** re the linear IR (47 dB above noise) in all three runs; Out 2 H2 −40 dB; Out 1 H3 −45 dB; Out 4 ≈ −52 dB. **Out 3's exciter/amp is markedly nonlinear at −30 dBFS** (rattle/buzz or a loose coupling — worth a physical check). ESS separates the harmonics from the linear FRF, the pulse train does not. |
| **Interface crosstalk** (sweep on Out e → In 8, marker removed) | −57…−85 dB re the receivers' responses — negligible. |
| **Early arrival** (deconvolved IR at t = 0..2 samples vs t < 0 ringing) | no distinct t = 0 component; |h(0..2)| ≤ −31 dB re peak only on the nearest sensor (Out 1→In 1, Out 3→In 3/4, first arrival 7–22 samples = band-limited ringing of the acoustic arrival). Electrical crosstalk in the exciter path is ≤ −31…−60 dB (upper bound); the definitive test (unconnected output / unplugged transducer) is in the rig plan. |
| **Reciprocity** | not possible: no sensor can be driven and no exciter sensed (piezo receivers, voice-coil exciters). |
| **ESS quasi-stationarity** r/(πB²) of the 8 s coarse sweep at the swept modes | 0.44 (<250 Hz), 0.21, 0.08, 0.01 — transient below 250 Hz. Deconvolution makes the FRF exact for an LTI system at any rate; the repeat coherence says the board is LTI, so a slower sweep mainly buys SNR (+10 log T) and sensitivity to Out 3's nonlinearity. Measured in the rig plan. |

## 2. PolyMAX (multi-reference pLSCF + LSFD)

**Synthetic validation** (`tests/unit/test_polymax.py`): 22 modes 400–712 Hz, ζ ≈ 3 %, spacing
2–4 % (modal overlap 1.5–3) plus a pair 0.8 % apart, 7 receivers × 4 exciters. The CMIF shows ONE
peak; the swept peak method (on the same simulated plant through its full ESS → zones → fine → fit
chain) recovers 0–5 of 22; PolyMAX recovers 22/22 (f < 0.5 %, median 0.05 %; ζ < 15 %), 0 spurious, at
noise 3e-3 of mean |H| (21/22 at 1e-4 plant noise through the ESS chain). The 0.8 % pair is resolved.

**Rig (rig3 coarse FRF):** 60 modes, all ≤ 2 kHz (30–60 Hz: 3, 60–120: 8, 120–250: 12, 250–500: 10,
500–1k: 23, 1–2k: 4); median ζ 1.7 % (duplicate poles of one mode — residue MAC ≥ 0.9 within half a
half-power width — are merged). **Above 2 kHz no pole is MPF-stable** across model orders —
frequencies and damping stabilise, the participation vectors do not: the 4-exciter data there do not
follow one consistent modal model (the σ2/σ1 ≈ 0.5 of §1). Dropping the MPF criterion yields 30–80
"stable" poles per band that are not reproducible — not used.

| Consistency of PolyMAX | Result |
|---|---|
| leave-one-exciter-out (4 fits on 3 exciters each) | pairs match 41–46 modes vs chance 12–16; df 0.09–0.12 %, dζ 4–7 %, shape MAC median 0.46–0.70 (chance 0.13) |
| across runs rig1/2/3 | 43 of 83 clusters in all 3 runs, 21 in 2; df 0.15 %, dζ 4.6 %, MAC 0.82 |

## 3. ESPRIT on chirp-derived impulse responses

The coarse ESS captures were deconvolved to **0.85 s** IRs (≥ the 400–600 ms band configs; < the 8 s
sweep's 2nd-harmonic advance 0.89 s), In 2–In 7 (the project's response channels), and run through
the UNCHANGED ESPRIT pipeline with the project's `extended_8band` parameters (GPU).

| | chirp-ESPRIT (rig3) | impulse-ESPRIT (old, 100 ms cycles) |
|---|---|---|
| modes per exciter | 136 / 134 / 129 / 131 | 124 / 137 / 133 / 128 |
| median ζ | 0.64 % | 0.77 % |
| cross-exciter pairs matched (chance) | 32–44 (30–37) | 35–44 (32–36) |
| shape MAC of matched pairs (chance 0.16) | 0.13–0.26 | 0.11–0.28 |
| modes found by all 4 exciters | 21 of 334 | 15 of 320 |
| same exciter, across runs rig1/2/3 | f 0.03–0.15 %, MAC ≈ 1.0, 45–60 % of the clusters found in all 3 runs | — |

Longer IRs did **not** make per-exciter ESPRIT consistent: it is perfectly repeatable on the same data
(the data repeat to 45 dB) but each exciter's ~130 poles agree with another exciter's only at chance
level. Single-reference ESPRIT on heavily overlapped 3 %-damped modes fits ~130 low-damping poles per
path (ζ ≈ 0.6 % vs 1.7–3.2 % from the FRF methods) — they describe each path, not shared modes.

## 4. Cross-method agreement (collapsed lists; shapes In 2..In 7)

| Pair | matched (chance) | per band (<250 / 250–1k / 1–2k / 2k+): matched, MAC median |
|---|---|---|
| A swept peak (70) vs **B PolyMAX** (60) | **39 (14.5)** | 16 MAC **0.94** / 20 MAC **0.79** / 3 MAC 0.46 / 0 |
| A vs C chirp-ESPRIT (334) | 60 (53.5) | MAC 0.22 / 0.42 / 0.27 / 0.15 |
| A vs D impulse-ESPRIT (320) | 56 (53.2) | MAC 0.53 / 0.45 / 0.07 / 0.43 |
| B vs C | 45 (35.0) | MAC 0.27 / 0.39 / 0.01 / — |
| B vs D | 43 (36.0) | MAC 0.40 / 0.46 / 0.05 / — |
| C vs D | 151 (142.5) | MAC 0.33 / 0.31 / 0.43 / 0.26 |

Damping: PolyMAX ζ is 18–38 % below the swept fit (median 1.7 vs 3.2 %); both ESPRIT variants are
another 2–4× lower. Half-power widths of the Σ|H|² peaks are wider still (297 Hz: 3.2 %, 372 Hz:
5.1 %) — even modes "isolated" by 4 ζ f in the PolyMAX list sit on overlapping neighbours, so
half-power is an upper bound here, not a reference. The damping level is unresolved — test 6 (appropriated free
decay, model-free, §6) is the decisive measurement.

## 5. Conclusions (offline)

1. **Trust the FRF-based multi-reference methods, not per-exciter ESPRIT, on this board.** Swept
   (joint fit) and PolyMAX — independent algorithms on the same FRFs — agree on 39 modes (2.7×
   chance) with shape MAC 0.94 (<250 Hz) / 0.79 (250–1 kHz). ESPRIT (impulse or chirp IRs) agrees with
   nothing, including itself across exciters, at better than chance.
2. **Usable band / count today: ≈ 30 Hz–1 kHz, ~50–60 modes** (PolyMAX 56 modes < 1 kHz; ~36 confirmed
   by the swept method; 1–2 kHz only ~4 PolyMAX modes, 3 cross-confirmed). Above ~2 kHz the 4×7
   data do not support a consistent modal model (no MPF-stable poles; σ2/σ1 ≈ 0.5); the swept
   method's 16 modes there have chance-level MAC across exciters.
3. The shape inconsistency above 250 Hz is a property of the board/rig (repeatable, LTI, high SNR),
   not of the acquisition — more exciters/receivers or a different sensor layout, not more
   averaging, is what can raise it.
4. **Out 3 is strongly nonlinear** (H2 −24 dB at −30 dBFS); check its mounting. Chirp collection
   separates the distortion; the impulse train cannot.
5. The chirp collection is ready for exciter setups (new Measurements default to it); for ESPRIT on
   this board it changes little — the identification method, not the IR length, is the limit.

## 6. Multi-exciter optimal per-mode excitation (force appropriation)

User objective (2026-10-11): *push the board optimally at each mode frequency.* Package
`modal_adapter/appropriation/` (CLI `python -m pianoid_middleware.modal_adapter.appropriation`).

**Method.** For mode m (pole λ_m, residue matrix R_m, receivers × exciters, from PolyMAX / swept) the
exciter weights w (E = 4) for a sine at f_m maximise the mode's share of the board's modal energy,
`P_m(w) = |g_m|²‖R_m w‖² / Σ_r |g_r|²‖R_r w‖²`, g_r = 1/(jω_m − λ_r) — a generalized Rayleigh
quotient, solved as the top generalized eigenvector (real signed weights = the Dima / decka form, or
complex = amplitude + phase per exciter). Model-free alternative on a measured FRF matrix: maximise
`|uᴴHw|²/‖Hw‖²` (shape objective = Dima's criterion, with phase); the MMIF (real-force mode
indicator) is provided. Weights are scaled so the strongest exciter sits at −24 dBFS (per-exciter
limits possible).

**Appropriated dwell + free decay:** all 4 exciters at once (fade-in, dwell ≥ 6τ, lock-in over 40
cycles, 1-cycle fade-out), then the silent decay: analytic signal → modal filter (pseudo-inverse of
the neighbourhood's shapes) → demodulation → straight-line log-amplitude and phase fits ⇒ **model-free
f_n and ζ** (+ envelope residual = leftover neighbours). Dwell / decay are timed for ζ ≤ 0.5 % (the
lightest damping any method reported). Optional **force reference**: current-sense input channels
(e.g. the 2nd UMC1820 over ADAT, `--current-inputs`) give measured force phasors instead of the
commanded drive.

**Synthetic validation** (`tests/unit/test_appropriation.py`; 6 modes, four of them 400/410/422/440 Hz,
ζ 2.5–3.5 %, 7 × 4): modal purity 0.985–0.998 (complex = real here — the simulated modes are real)
vs 0.29–0.96 for the best single exciter; decay ζ within 0.6 % of the truth (3.002 vs 3.000 %,
2.501 vs 2.500 %, 3.491 vs 3.500 %), f within 0.07 %, steady MAC(Y, ψ) ≥ 0.988 — **the same when the
model's damping is wrong by ×0.5 or ×2** (the damping comes from the decay). The best single exciter's
decay is biased −8 % / +8 % (400 / 440 Hz, envelope beating 1.9–3.9 dB). End to end (ESS FRF →
PolyMAX → weights → dwell / decay): every mode within 0.3 % in ζ (a PolyMAX duplicate pole at 520 Hz
surfaced here → duplicates are now merged).

**Rig prediction** (rig3 PolyMAX model → `polymax\20261011-rig3\appropriation_table.json`): median
purity 0.72 complex / 0.68 real vs 0.60 for the best single exciter (<250 Hz 0.64 / 0.61 vs 0.44;
250–1k 0.76 / 0.72 vs 0.67). Four exciters can suppress at most three neighbours, so isolation stays
partial in the densest regions; the decay's envelope residual flags it per mode. Real weights lose
little vs complex on this board.

**Playback (decka).** `actuator_feed.npz` = W (exciters × modes), real signed, unit max per mode, with
the mode frequencies — the per-mode actuator drive pattern, i.e. decka semantics (dev-b59d: a decka
column = per-transducer drive weights of one mode). If the engine drives the board through Out 1–4,
output channel ch's feed row for engine mode k = W[ch, m(k)] for the board mode m matched to k by
frequency (the engine has one real coefficient per mode and channel — hence the real option).
Writing it into a preset is the converter's / output-level owner's job (P1) and needs the
board ↔ engine mode matching — not done here. Caveat: the FRFs are drive-VOLTAGE referenced (exciter
impedance included) — exactly what playback through the same amps needs; physical modal
participation needs the force (current) reference.

## 7. Rig test plan (pending the user's go)

All through `POST /audio/session` (synthesis paused per session), levels −36…−24 dBFS, never above
−24 (hard ceiling −12 in code). Outputs `D:\modal_measurements\rig_checks\<ts>-<check>\` and
`...\swept_discovery\<run>\`. Before: `GET :5000/audio/devices` shows UMC ASIO open; Out 6 must be
unconnected (user to confirm, else name a free output).

| # | Test | Command | Sessions · rig time |
|---|---|---|---|
| 1 | Crosstalk: ESS on the unconnected Out 6 + reference Out 3 (early arrival) | `rig_checks crosstalk --unconnected "Out 6"` | 2 × 11 s · ~0.5 min |
| 2 | Linearity: ESS 8 s at −36 / −30 / −24 dBFS per exciter (FRF deviation per band + H2/H3 vs level) | `rig_checks linearity --levels -36,-30,-24` | 12 × 11 s · ~2.5 min |
| 3 | Sweep speed: coarse ESS 8 / 30 / 60 s per exciter + noise per duration (SNR, FRF deviation vs 60 s, σ2/σ1) — then PolyMAX + swept zones on each FRF offline | `rig_checks sweep_speed --durations 8,30,60` | 15 sessions · ~9 min |
| 4 | Swept discovery with the fixed tags + the chosen coarse duration, fine rate cap (e.g. `--fine-rate 20 --fine-gap-tau 8`), `--repeat-fine 3` | `swept_discovery run ...` | ~7–10 min |
| 5 | Chirp collection end to end: new Measurement (chirp default), 4 exciters × 5 measurements, ESPRIT in the project, compare with §3 | Tunner Collection / REST | 20 × 11.5 s · ~4 min + ESPRIT 1 min |
| 6 | **Appropriation + free decay** on 13 modes — isolated 76, 206, 297, 372, 520, 1048 Hz; overlapped 160, 401, 541, 673, 677, 732, 795 Hz — complex weights, real weights, and the best single exciter; compare decay ζ / f with swept / PolyMAX / ESPRIT and the half-power checks (weights from the PolyMAX model of the new test 3/4 FRFs) | `appropriation dwell <modes.npz> --modes 76.4,159.6,205.9,297.3,372,401.1,520.3,540.6,672.6,677.4,732.2,795.4,1047.5 --single` + a `--real` pass | ~40 sessions · ~4 min |
| (7) | optional, needs the user's hands: one transducer unplugged at the amp output, re-run test 1 on that output (exciter-path electrical crosstalk) | — | ~0.5 min |
| (8) | when the 2nd UMC1820 current sensing (ADAT) is wired: repeat test 6 with `--current-inputs` (force reference) | — | ~4 min |

Total ≈ 30 min of rig time; then the comparison (§4) is re-run including the new FRFs and defaults are
set (coarse duration, fine rate) from test 3's SNR / deviation vs time cost.

## 8. Rig results (2026-10-12)

All sessions through `POST /audio/session` on the user's live backend (synthesis paused per session,
`/health` audio ok before and after): 0 xruns, loopback onset 334 frames in every session.
Raw data + reports: `D:\modal_measurements\rig_checks\20261012T160627-crosstalk`, `...T160700-linearity`
(+ `linearity_per_exciter.json`), `...T161018-sweep_speed` (+ `polymax_T{8,30,60}\`),
`D:\modal_measurements\swept_discovery\20261012-rig4b`, Measurement `ASIO-chirp-2026-10-12` / project
`ASIO-chirp-2026-10-12_p1`, `D:\modal_measurements\appropriation\20261012T164630` (complex + single) and
`...T164732` (real). Analysis: `D:\modal_measurements\analysis\dev-fd69-2026-10-12\` (`comparison.log`,
`appropriation_damping.log`, `damping_appropriation_vs_methods.png`, `modes_per_exciter_by_method.png`,
`cross_method_vs_chance.png`); scripts `docs/development/diagnostics/dev-fd69-{rig-comparison-2026-10-12,appropriation-damping,chirp-collection-e2e}.py`.

**1 — Crosstalk.** ESS on the unconnected Out 6: receivers at −63 (<250 Hz), −71, −70, −69 dB re the Out 3
response → interface/cabling crosstalk negligible. Out 3 early arrival: no t = 0 component beyond the
acoustic arrival's ringing (In 3/In 4 first arrival 8/22 samples).

**2 — Linearity per exciter** (8 s ESS at −36 / −30 / −24 dBFS; FRF deviation vs −30 dBFS, median over lines
within 20 dB of the peak; H2 = 2nd-harmonic IR re linear):

| Exciter | FRF dev −36 vs −30 (<250 / 250–1k / 1–2k / 2k+) | FRF dev −24 vs −30 | H2 at −36 / −30 / −24 dBFS |
|---|---|---|---|
| Out 1 | 1.01 / 0.10 / 0.03 / 0.18 dB | 0.34 / 0.20 / 0.04 / 0.39 dB | −58.5 / −60.0 / −53.9 dB (H3 −43…−45) |
| Out 2 | 0.32 / 0.11 / 0.02 / 0.11 dB | 0.22 / 0.17 / 0.10 / 0.21 dB | −45.8 / −40.2 / −34.4 dB |
| **Out 3** | 0.13 / 0.16 / 0.07 / 0.34 dB | 0.41 / 0.18 / 0.15 / 0.55 dB | **−29.5 / −22.9 / −16.8 dB** |
| Out 4 | — / 0.08 / 0.04 / 0.19 dB | — / 0.20 / 0.17 / 0.46 dB | −57.8 / −49.9 / −43.8 dB |

The LINEAR FRFs scale within 0.1–0.5 dB (worst: Out 1 <250 Hz at −36 dBFS, SNR-limited). Out 3's H2 grows
6 dB per 6 dB of drive (2nd-order distortion, 7 % at −30 dBFS, 14 % at −24 dBFS) — its transducer/mounting
is the nonlinear element (still unchecked); Out 2 the same pattern 17 dB lower. ESS/chirp separates it;
stay at ≤ −30 dBFS for Out 3 (test 6 ran at −30 dBFS for that reason).

**3 — Sweep speed** (coarse ESS 8 / 30 / 60 s × 4 exciters, noise per duration):

| ESS | wall time (4 exc. + noise) | SNR <250 / 250–1k / 1–2k / 2k+ | FRF dev vs 60 s (<250 Hz) | σ2/σ1 at peaks | PolyMAX modes |
|---|---|---|---|---|---|
| 8 s | 62 s | 56.4 / 63.8 / 62.2 / 60.4 dB | 0.12 dB, 2.7 % | 0.36 / 0.39 / 0.56 / 0.50 | 65 |
| 30 s | 178 s | 62.5 / 68.6 / 68.2 / 66.2 dB | 0.05 dB, 1.2 % | 0.35 / 0.38 / 0.56 / 0.50 | 67 |
| 60 s | 342 s | 66.0 / 72.8 / 70.9 / 69.2 dB | — | 0.35 / 0.38 / 0.56 / 0.51 | 69 |

SNR follows 10 log T; the FRFs differ by ≤ 0.12 dB; the shape inconsistency (σ2/σ1) is unchanged; PolyMAX
on 8 / 30 / 60 s agrees like run-to-run repeats (41 of 93 clusters in all three, df 0.16 %, dζ 5 %). A
slower sweep does not change what can be identified on this board. **New defaults:** coarse ESS **20 s**
(+4 dB, LF quasi-stationarity 0.44 → 0.18, +50 s per run); fine zone sweeps capped per zone at a
quasi-stationarity index **0.05** (`--fine-qs`, ≤ 20 s per zone), decay gap **8 τ ≤ 3 s**. (An absolute
fine rate cap of 30 Hz/s was tried first and failed: wide HF zones became 158 s sessions > the backend's
120 s limit → replaced by the per-zone bandwidth-relative cap.)

**4 — Swept rerun** (`20261012-rig4b`, new defaults, 3 repeats of the 6 strongest zones): 73 modes
33–7384 Hz (21 / 23 / 13 / 16 per band), median ζ 3.0 %, 491 s (coarse 101, fine 342). Session tags all
unique on disk (`fine_e*`, `repeat{1..3}_fine_e*`) — the overwrite fix verified live. Repeatability (24
modes): f spread median 0.074 % (was 0.15 %), max 0.75 %; ζ spread median 7.2 %, max 112 % (overlapped
modes).

**5 — Chirp collection end to end** (new Measurement → chirp default, 9.87 s ESS, 1 s IRs, 4 exciters × 5;
modal adapter :5001 started from the integration worktree for this test only and stopped after — it was not
running before): 20 sessions 0 xruns, onset 334; per-measurement harmonic metadata reproduces test 2
(H2 −53.5 / −39.7 / −23.2 / −49.6 dB for Out 1–4); averaged IRs 48 000 samples; project + mapping + ESPRIT
200 in 71 s: 139 / 135 / 133 / 130 modes, median ζ 0.85–1.0 %. Same exciter vs the offline chirp-ESPRIT of
2026-10-11 (Out 3): MAC 0.98, df 0.09 % — repeatable; cross-exciter still at chance (pairs 36–45 vs 31–40).

**6 — Appropriation + free decay** (13 modes, PolyMAX model from the 60 s FRF, −30 dBFS, complex weights +
the best single exciter, then real weights):

| f decay (Hz) | ζ appropriated complex (env. residual) | real | single exciter (env.) | PolyMAX | swept | chirp-ESPRIT | impulse-ESPRIT |
|---|---|---|---|---|---|---|---|
| 76.8 | 2.50 % (3.4 dB) | 2.88 | 3.28 (0.6) | — | 2.86 | — | — |
| 159.9 | 2.12 (0.8) | 2.12 | 2.07 (0.5) | 2.01 | 2.66 | 0.15 | 0.20 |
| 206.0 | 2.46 (1.5) | 2.50 | 3.38 (3.1) | 1.86 | 2.13 | 0.63 | 3.85 |
| 298.3 | 2.07 (1.1) | 2.03 | 1.98 (1.0) | 1.70 | 3.92 | 1.25 | 1.48 |
| 372.9 | 1.39 (1.5) | 1.37 | 1.38 (0.5) | 1.58 | 2.62 | 0.93 | 0.69 |
| 403.4 | 1.38 (0.3) | 1.39 | 1.45 (1.4) | 1.35 | — | 1.19 | 1.67 |
| 520.2 | 2.44 (1.5) | 2.53 | 2.10 (1.5) | 2.50 | 2.97 | 1.72 | 1.85 |
| 541.0 | 1.58 (1.3) | 1.58 | 1.65 (1.2) | 1.75 | 2.32 | 1.66 | 1.33 |
| 635.5 | 1.84 (4.1) | 1.94 | 1.44 (1.8) | — | 4.45 | 0.69 | 1.78 |
| 652.9 | 1.36 (2.8) | 1.31 | 1.35 (4.8) | 1.46 | — | 1.42 | 1.48 |
| 733.8 | 1.56 (0.9) | 1.51 | 1.54 (0.8) | 1.58 | 1.65 | — | 1.23 |
| 791.5 | 1.47 (0.8) | 1.45 | 1.47 (0.7) | 1.50 | 2.01 | 1.57 | 1.29 |
| 958.5 | 1.14 (4.9) | 1.17 | 1.25 (1.7) | 1.27 | — | 0.98 | 1.13 |

On the 9 clean decays (envelope residual < 2 dB), relative to the appropriated ζ: real weights 1.00
(0.97–1.03), **PolyMAX 1.01** (0.76–1.14), single exciter 1.00 (0.86–1.38), **swept 1.31** (0.87–1.90),
chirp-ESPRIT 0.69 (0.07–1.07), impulse-ESPRIT 0.79 (0.09–1.57). Appropriated ζ median **1.58 %**
(1.1–2.5 %). Four decays (76.8, 635.5, 652.9, 958.5 Hz) beat (3–5 dB envelope residual) — the 4-exciter
appropriation cannot isolate them; two of those (635.5, 958.5 Hz) decayed at a neighbouring frequency
(model frequency 644.9 / 979.2 Hz); their ζ is indicative only. Real weights reproduce complex ones on this
board (ζ within 3 %).

**Damping disagreement — settled:** ζ ≈ 1.1–2.5 % (median ≈ 1.6 %) between 150 Hz and 1 kHz. PolyMAX's
damping is right (within ±15 %, median 1 %); the swept rational fit over-estimates by ~30 % (median 3.0 %
vs 1.6 %); per-exciter ESPRIT (impulse or chirp) is erratic and biased low (down to 0.1–0.2 % at 160 Hz).

**Cross-exciter + cross-method (2026-10-12 data):**

| Method | modes / exciter | cross-exciter pairs matched (chance) | shape MAC (chance 0.12–0.16) |
|---|---|---|---|
| A swept rig4b (joint) | 73 (all 4) | joint by construction | 0.20–0.30 |
| B PolyMAX 60 s (joint) | 69 (all 4); 0 above 2 kHz | joint; leave-one-out pairs 40–49 (14–17) | LOO 0.49–0.71 |
| C chirp-ESPRIT (live) | 130–139 | 36–45 (31–40) | 0.12–0.27 |
| D impulse-ESPRIT | 124–137 | 35–44 (32–36) | 0.11–0.28 |

| Pair | matched (chance) | MAC <250 / 250–1k / 1–2k |
|---|---|---|
| A vs B | **39 (19.0)** | **0.81 / 0.63** / 0.27 |
| A vs C | 67 (56.5) | 0.17 / 0.52 / 0.38 |
| A vs D | 58 (55.8) | 0.37 / 0.48 / 0.43 |
| B vs C | 55 (38.5) | 0.24 / 0.36 / 0.13 |
| B vs D | 42 (40.0) | 0.48 / 0.43 / 0.19 |
| C vs D | 157 (151.5) | 0.22 / 0.33 / 0.31 |

**Conclusions (rig-confirmed):** the offline conclusions of §5 hold. Use **PolyMAX** for f, ζ and the
multi-reference shapes (its ζ matches the model-free decays), with the **swept** method as the
independent frequency/shape cross-check (its ζ is ~30 % high); per-exciter ESPRIT is not usable on this
board, with impulse or chirp IRs alike. Usable band ≈ 30 Hz–1 kHz (~55–65 modes), 1–2 kHz marginal, no
consistent modal model above 2 kHz with 4 exciters × 7 piezo receivers. Out 3 is the nonlinear exciter
(2nd order; ≤ −30 dBFS). For playback the real per-mode weights (`actuator_feed.npz`) are as good as
complex ones here.

## Investigation history

- 2026-10-11 consistency analysis (swept vs impulse-ESPRIT): `D:\scratch\xexc-2026-10-11\analysis.log`
  (now reproduced by `modal_adapter/mode_comparison.py`).
- Swept design + first rig runs: [swept-sine-mode-discovery-2026-10-11.md](../proposals/swept-sine-mode-discovery-2026-10-11.md).
