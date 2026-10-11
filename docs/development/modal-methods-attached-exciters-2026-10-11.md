# Modal identification with attached exciters — rig checks, PolyMAX, chirp-ESPRIT, comparison (2026-10-11)

**Status:** implemented + validated OFFLINE (dev-fd69, Core `feature/dev-fd69-modal-methods`, Tunner
`feature/dev-fd69-chirp-ui`, both unmerged). Live rig tests pending (the interface was disconnected
during the session) — plan in [§6](#6-rig-test-plan-pending-the-users-go).
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

**Rig (rig3 coarse FRF):** 63 modes, all ≤ 2 kHz (30–60 Hz: 4, 60–120: 10, 120–250: 12, 250–500: 10,
500–1k: 22, 1–2k: 5); median ζ 1.7 %. **Above 2 kHz no pole is MPF-stable** across model orders —
frequencies and damping stabilise, the participation vectors do not: the 4-exciter data there do not
follow one consistent modal model (the σ2/σ1 ≈ 0.5 of §1). Dropping the MPF criterion yields 30–80
"stable" poles per band that are not reproducible — not used.

| Consistency of PolyMAX | Result |
|---|---|
| leave-one-exciter-out (4 fits on 3 exciters each) | pairs match 40–48 modes vs chance 12–16; df 0.08–0.13 %, dζ 4–7 %, shape MAC median 0.46–0.67 (chance 0.13) |
| across runs rig1/2/3 | 39 of 90 clusters in all 3 runs, 28 in 2; df 0.12 %, dζ 4.8 %, MAC 0.84 |

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
| A swept peak (70) vs **B PolyMAX** (63) | **40 (13.8)** | 16 MAC **0.93** / 21 MAC **0.80** / 3 MAC 0.45 / 0 |
| A vs C chirp-ESPRIT (334) | 60 (53.5) | MAC 0.22 / 0.42 / 0.27 / 0.15 |
| A vs D impulse-ESPRIT (320) | 56 (53.2) | MAC 0.53 / 0.45 / 0.07 / 0.43 |
| B vs C | 45 (34.8) | MAC 0.22 / 0.39 / 0.03 / — |
| B vs D | 44 (35.5) | MAC 0.33 / 0.41 / 0.20 / — |
| C vs D | 151 (142.5) | MAC 0.33 / 0.31 / 0.43 / 0.26 |

Damping: PolyMAX ζ is 18–38 % below the swept fit (median 1.7 vs 3.2 %); both ESPRIT variants are
another 2–4× lower. Half-power widths of the Σ|H|² peaks are wider still (297 Hz: 3.2 %, 372 Hz:
5.1 %) — even modes "isolated" by 4 ζ f in the PolyMAX list sit on overlapping neighbours, so
half-power is an upper bound here, not a reference. The damping level is unresolved (§6 sweep-speed
and fine-rate tests are the next evidence).

## 5. Conclusions (offline)

1. **Trust the FRF-based multi-reference methods, not per-exciter ESPRIT, on this board.** Swept
   (joint fit) and PolyMAX — independent algorithms on the same FRFs — agree on 40 modes (3× chance)
   with shape MAC 0.93 (<250 Hz) / 0.80 (250–1 kHz). ESPRIT (impulse or chirp IRs) agrees with
   nothing, including itself across exciters, at better than chance.
2. **Usable band / count today: ≈ 30 Hz–1 kHz, ~50–60 modes** (PolyMAX 58 modes < 1 kHz; ~40 confirmed
   by the swept method; 1–2 kHz only ~5 PolyMAX modes, 3 cross-confirmed). Above ~2 kHz the 4×7
   data do not support a consistent modal model (no MPF-stable poles; σ2/σ1 ≈ 0.5); the swept
   method's 16 modes there have chance-level MAC across exciters.
3. The shape inconsistency above 250 Hz is a property of the board/rig (repeatable, LTI, high SNR),
   not of the acquisition — more exciters/receivers or a different sensor layout, not more
   averaging, is what can raise it.
4. **Out 3 is strongly nonlinear** (H2 −24 dB at −30 dBFS); check its mounting. Chirp collection
   separates the distortion; the impulse train cannot.
5. The chirp collection is ready for exciter setups (new Measurements default to it); for ESPRIT on
   this board it changes little — the identification method, not the IR length, is the limit.

## 6. Rig test plan (pending the user's go)

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
| (6) | optional, needs the user's hands: one transducer unplugged at the amp output, re-run test 1 on that output (exciter-path electrical crosstalk) | — | ~0.5 min |

Total ≈ 25 min of rig time; then the comparison (§4) is re-run including the new FRFs and defaults are
set (coarse duration, fine rate) from test 3's SNR / deviation vs time cost.

## Investigation history

- 2026-10-11 consistency analysis (swept vs impulse-ESPRIT): `D:\scratch\xexc-2026-10-11\analysis.log`
  (now reproduced by `modal_adapter/mode_comparison.py`).
- Swept design + first rig runs: [swept-sine-mode-discovery-2026-10-11.md](../proposals/swept-sine-mode-discovery-2026-10-11.md).
