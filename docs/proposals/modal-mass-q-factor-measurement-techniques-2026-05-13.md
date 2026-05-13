# Modal Mass and Q-Factor — Staged Measurement Techniques (Research Proposal)

**Date:** 2026-05-13
**Status:** RESEARCH PROPOSAL — read-only investigation. NO code changes proposed yet; user
decision required before any implementation work begins.
**Author:** /analyse pass (orchestrator-spawned read-only research).
**Scope:** Add a family of staged, mode-targeted measurement techniques to Pianoid's Modal
Adapter to extract modal damping (Q-factors) and modal masses with higher SNR / better
isolation than the broadband single-shot impulse response that ESPRIT consumes today.
**User direction:**
> Research how can I determine modal masses/quality factors by staging different kind of
> measurements. For example, emitting signal with the frequency swiping around the
> frequency of the mode can give idea of its quality factors, or emitting signal on the
> frequency in between two modes can give idea about their relative masses.

---

## 1. Executive Summary

Pianoid's Modal Adapter today offers exactly **one** measurement type: a short broadband
pulse (sine / square / voice-coil — see `recorder._generate_single_pulse`) repeated
N times per cycle, M times per scenario, mean-averaged into one impulse response per
channel, then decomposed by ESPRIT. Every modal parameter Pianoid extracts (frequency,
damping ratio, mode shape) comes from that one signal type.

This is excellent for **mode discovery** — ESPRIT extracts hundreds of poles from a single
broadband shot — but it is **structurally weak** for two of the three quantities the
synthesis engine actually consumes:

| Quantity | Today's source | Weakness |
|---|---|---|
| **Frequency** | ESPRIT pole on the impulse response | Strong. Poles are well-conditioned even at moderate SNR. |
| **Damping ratio** (`zeta`, equivalently Q = 1/(2·zeta)) | ESPRIT pole real part | Moderate. Damping is sensitive to model order, band split, and the particular cycle-pool that survives calibration. The pole's Q estimate is a global least-squares fit over a wide band — close modes contaminate each other's damping. |
| **Modal mass** (or its inverse — modal participation / residue) | **Not separately measured.** Mode shape `mode_shapes[mode, channel]` carries spatial pattern only. The conversion to engine `omega` / `dec` / `feedin` does NOT use a calibrated modal mass — only relative coupling per excitation point. | Strong: there is no measurement that *isolates* per-mode energy from a known input force. Modal mass is implicitly bundled into the un-normalized mode shape. |

The user's two-line intuition captures the two textbook fixes for these weaknesses:

1. **"Sweep around a mode's frequency"** is the **half-power bandwidth method** — the
   classical, model-free, mode-isolated way to measure Q. SNR per measurement is
   far higher than ESPRIT's broadband fit because all the energy goes into one mode.
2. **"Emit between two modes and look at relative response"** is **off-resonance FRF
   curve-fitting** — at a frequency `f` between modes `k` and `k+1`, the steady-state
   response amplitude is dominated by `|A_k / (f² − f_k²) + A_{k+1} / (f² − f_{k+1}²)|`.
   With several such between-mode probes (and known forcing input from the existing
   calibration channel), the residues `A_k` (which factor as `mode_shape² / modal_mass`)
   can be solved as a small linear system, giving relative modal masses.

This proposal lays out **6 Q-factor techniques + 5 modal-mass techniques** from the
experimental modal analysis literature, evaluates each against Pianoid's current
infrastructure, and recommends a **3-phase rollout** that ships the lowest-effort
highest-value technique (stepped-sine bandwidth Q) first and defers hardware-dependent
mass-loading to last (or never).

The Modal Adapter Measurement-entity refactor (dev-msmt 2026-05-11, see
[`modal-adapter-measurement-entity-2026-05-10.md`](modal-adapter-measurement-entity-2026-05-10.md))
already provides the **structural hook** for adding new measurement types: each
Measurement carries `setup/impulse_config.json` with an `impulse_form` field
(currently `sine | square | voice_coil`) and the recorder generates the playback signal
from it. Adding `swept_sine | stepped_sine | between_modes_probe` as new `impulse_form`
values is the natural extension point — new techniques become new entries in a familiar
5-section setup, NOT a parallel system.

---

## 2. Background — What Pianoid Has Today

Skip if familiar. Reference for the analysis below.

### 2.1 Excitation pipeline

`pianoid_middleware.modal_adapter.measurement.recorder.RoomResponseRecorder`:

- `_generate_single_pulse(exact_samples)` — produces ONE pulse of one of three forms:
  - `sine`: `sin(2π·f·t)` over the pulse duration with linear fade in/out
  - `square`: constant 1.0 with linear fade in/out
  - `voice_coil`: square pulse + ramp pull-back tail
  - All scaled by `volume × 0.3`.
- `_generate_complete_signal()` — places `num_pulses` copies of the single pulse at
  intervals of `cycle_samples`, total duration `cycle_samples × num_pulses`.
- The signal is handed to `sdl_audio_core.measure_room_response_auto_multichannel` which
  plays it on the chosen output device while simultaneously recording on all input
  channels.

Pianoid's playback path can therefore emit **arbitrary deterministic waveforms up to
about 30 s long** with sample-accurate timing — the only thing limiting it to "short
pulse + silent gap × N" is the formula inside `_generate_single_pulse` /
`_generate_complete_signal`. Sweeps, stepped sine, and dual-tone signals all fit into
the same pipeline (see [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md` § Recorder
Configuration Overrides (v1)](../modules/pianoid-middleware/MODAL_COLLECTION.md#recorder-configuration-overrides-v1)).

### 2.2 Capture pipeline

The recorder captures on the multichannel input and runs:
1. **Cycle extraction** by calibration-channel onset detection
2. **Cycle alignment + correlation filtering** against a reference cycle
3. **Per-channel mean** across surviving cycles
4. **Truncation** to `ir_working_length_ms` with a Hann fadeout

All four steps are tuned for short impulses; for sustained excitation (sweep / stepped
sine), steps 1-2 must be bypassed and replaced with a deconvolution step (sweep) or a
per-step steady-state amplitude extraction (stepped sine). See § 5.3.

### 2.3 ESPRIT extraction

`ModalAdapter` runs **band-split ESPRIT** on the averaged IR. Per scenario, output is:

- `frequencies` (Hz, n_modes)
- `damping_ratios` (dimensionless ζ, n_modes) — Q = 1/(2·ζ)
- `mode_shapes` (complex, n_modes × n_channels)
- `poles` (continuous-time complex)

There is no measurement entity in the system today that produces only Q (without
re-running ESPRIT) or only modal mass (full stop — modal mass is never measured).

### 2.4 Calibration channel — the key enabler

Pianoid records a dedicated **calibration channel** (e.g. an accelerometer or shunt-
resistor probe co-located with the actuator) that captures the actual injected force
waveform. This is critical for everything in this proposal — without it, the techniques
below would need a separately-measured input transfer function to compensate for the
actuator's frequency response. With it, **all FRFs are computed as
`H(f) = Y_response(f) / X_calibration(f)`** so the actuator's dynamics drop out.

The reference channel (used today as a precedent / time-reference) plays the same
role for stepped-sine and swept-sine measurements.

---

## 3. Stream 1 — Q-factor Measurement Techniques

### 3.1 Method matrix

| Method | Excitation | Per-mode time cost | Practical Q range | Implementation effort | New audio capability? |
|---|---|---|---|---|---|
| **3.1.A — Half-power (-3 dB) bandwidth, stepped sine** | Discrete tones at N frequencies dwelling for steady-state | ~5-10 s per mode (10-20 steps × 0.5 s dwell) | 5 - 1000+ | LOW. New `stepped_sine` impulse_form; reuses recorder infrastructure | No — sustained sine within current playback budget |
| **3.1.B — Half-power bandwidth, narrow swept sine** | Linear or log sweep over `[f_n − k·BW, f_n + k·BW]` for ~1 s | ~2-3 s per mode | 5 - 500 (limit at high Q from sweep rate) | LOW-MED. New `swept_sine` impulse_form + Farina-style deconvolution | No |
| **3.1.C — Log-decrement from impulse decay (already implicit in ESPRIT)** | Existing broadband impulse | 0 — already measured | 5 - ∞ in principle | NONE for today's pipeline; gain comes from per-mode bandpass + Hilbert envelope log fit done OUTSIDE ESPRIT | No |
| **3.1.D — Phase-resonance criterion (drive-point at resonance, measure 90° lag)** | Stepped sine OR sustained tone at f_n | ~1-2 s per mode | 5 - 500 (phase noise dominates at very low Q) | LOW once 3.1.A is shipped (re-uses stepped-sine playback + adds phase extraction) | No |
| **3.1.E — Random vibration + transfer function H1/H2 estimator** | Broadband Gaussian noise for ~5-10 s | Single recording covers all modes simultaneously | 5 - 200 | MED. New `random_excitation` form + H1 estimator (Welch's method) | No (sustained noise is well within budget) |
| **3.1.F — Multi-sine (Schroeder phase, optimal-crest-factor)** | Pre-computed sum of sinusoids at f_1, f_2, …, f_M | ~5 s for whole mode set | 5 - 500 | MED-HIGH. New form + multi-tone solver | No |

### 3.2 Per-method analysis

#### 3.1.A — Half-power bandwidth, stepped sine

**This is the user's primary suggestion and the textbook method.** At each frequency
step `f_i ∈ [f_n − k·BW, f_n + k·BW]` (typically k=2-3 to capture both -3 dB points
plus shoulder), the recorder plays a sine tone at `f_i` for a dwell time `T_dwell` and
extracts the steady-state response amplitude `|H(f_i)|`. After the sweep, fit the
peak (parabola or Lorentzian) to find the **resonance frequency** and the two
half-power points where `|H|² = |H_peak|²/2` (equivalent to `|H| = |H_peak|/√2`,
or -3 dB on a dB scale). The **Q-factor** is then:

```
Q  =  f_n / (f_2 − f_1)
ζ  =  1 / (2 Q)  =  (f_2 − f_1) / (2 f_n)         [valid for ζ < 0.1]
```

A more accurate formula valid up to ζ ≈ 0.3 (Wang/Liu correction):
```
ζ  =  (f_2² − f_1²) / (4 f_n²)
```

**Per-mode cost.** For a mode with predicted Q ≈ 100 at f_n = 500 Hz, the bandwidth
is BW ≈ 5 Hz. Sweeping ±3·BW with 1 Hz resolution = 31 steps; with 0.5 s dwell each
that's 16 s per mode. For the bass register (Q ~ 200, BW ~ 0.5 Hz at 100 Hz), the
dwell needs to grow to 2-3 s for steady state to settle, so 60-90 s per mode. **Smart
strategy:** seed each mode's BW from the ESPRIT damping estimate, then refine.

**Steady-state dwell requirement.** Critical detail: the response only settles to
steady state after roughly `5/2π·f_n·ζ ≈ Q/π · T_period` cycles. For Q=100 at 500 Hz
that's 32 cycles = 64 ms — comfortable. For Q=200 at 100 Hz that's 64 cycles = 640 ms.
The stepped-sine controller MUST wait at least this long before sampling response
amplitude; cutting the dwell shortens accuracy badly for high-Q modes. **Recommendation:**
adaptive dwell = `max(T_min, 5 · Q_estimate / (π · f_n))`.

**SNR.** All transducer + actuator energy at frequency `f_i` lands in one bin —
this is the optimal SNR-per-Hz of any modal measurement technique. Vastly better
than impulse for high-Q modes where the impulse response decays before the SNR
average can build up.

**Pianoid integration.** New `impulse_form: "stepped_sine"` with sub-config:
`f_start_hz`, `f_end_hz`, `n_steps`, `dwell_ms`, `linear_or_log`. Recorder generates
a long signal `concat([sine(f_i, dwell) for i in steps])` with brief silent gaps (10-20 ms)
between steps so the per-step response can be windowed cleanly. New post-processing
`extract_stepped_sine_q(recording)` → `{f_n_refined, Q, BW_-3dB, fit_quality}` per
target mode. Result lives next to ESPRIT in the Project's analysis tree.

#### 3.1.B — Half-power bandwidth, narrow swept sine (Farina ESS)

Continuous logarithmic sine sweep `s(t) = sin(2π · f_start · ((f_end/f_start)^(t/T) − 1) / ln(f_end/f_start))`
over a narrow band around the target mode for ~1 s, then **inverse convolution** with
the analytic inverse sweep to recover the impulse response of just that band. FFT
the recovered IR → high-resolution `H(f)` → -3 dB bandwidth same as 3.1.A.

**Advantage over stepped-sine.** Faster (1 s vs 16 s for one mode) and gives the full
H(f) curve — not just discrete points. The Farina method's nonlinearity rejection is a
nice bonus for our soundboard application (the actuator is mildly nonlinear at high
volume).

**Disadvantage.** Sweep rate must be slow enough that the mode "tracks" the sweep —
empirical rule `df/dt < f_n²·ζ²` or the FRF gets distorted (tracking-rate error).
For Q=200 at 100 Hz that's `df/dt < 0.025 Hz/s` — extremely slow, defeating the
"faster than stepped" advantage. **Stepped-sine wins for very-high-Q bass modes;
swept-sine wins for moderate-Q midrange modes.**

**Pianoid integration.** New `impulse_form: "swept_sine"` with sub-config: `f_start_hz`,
`f_end_hz`, `sweep_duration_ms`, `sweep_type: "linear" | "log"`. Recorder generates the
sweep waveform; post-processor runs Farina deconvolution against the calibration channel
recording (NOT against the playback signal — using the calibration channel automatically
removes the actuator's transfer function).

#### 3.1.C — Log-decrement from existing impulse (free upgrade)

ESPRIT's pole imaginary part already encodes ζ via `pole = -ζ·ω_n + j·ω_d`. The
**hidden information** that a per-mode bandpass + Hilbert-envelope log-fit could
extract from the SAME averaged impulse response Pianoid already has:

1. Bandpass the averaged IR around `f_n ± 3·BW_predicted` (predicted from ESPRIT's
   own first pass).
2. Hilbert transform → analytic signal envelope `e(t) = |IR(t) + j·H(IR)(t)|`.
3. Linear fit `log(e(t)) = log(A) − ζ·ω_n·t` over the cleanly-decaying region (skip
   first 5-10 ms transient + last region where SNR drops below noise floor).

**Expected agreement with ESPRIT.** When the mode is well-isolated (no neighbor within
3·BW), the two estimates should agree to within the noise floor — useful as a sanity
cross-check. When ESPRIT and log-decrement disagree, the disagreement diagnoses
mode-overlap contamination (one of the dev-msmt era persistent puzzles).

**Per-mode cost.** Zero new measurement; ~1 ms compute per mode. **Should be added as
a routine cross-validation alongside ESPRIT regardless of whether anything else in this
proposal ships.**

**Pianoid integration.** Pure post-processor in the existing ESPRIT analysis tree.
New file `modal_adapter/qc/log_decrement_xcheck.py` consuming the averaged IR + chain
center frequencies; output is a `{chain_id: {Q_esprit, Q_logdec, agreement_ratio}}`
dict surfaced as a Tracking-section QC chip. Lowest possible effort.

#### 3.1.D — Phase-resonance / 90° quadrature

At `f = f_n` exactly, the response leads (or lags, sign convention) the input by
exactly 90°. By stepping a tone over a tight `[f_n − Δ, f_n + Δ]` and finding the
zero-crossing of `Im(H)` (or the 90° point of the phase), the resonance frequency is
located more precisely than by amplitude-peak fitting alone. Combined with the half-
power bandwidth, this tightens Q.

**Most useful when amplitude is noisy** (e.g. low-volume measurement, soft mallet) but
phase is still clean. Requires synchronous detection — multiplying the response by
`sin(2π·f·t)` and `cos(2π·f·t)` and integrating over the dwell period (lock-in
amplifier in software).

**Pianoid integration.** Adds a phase-extraction step to the stepped-sine post-
processor — same recorder waveform as 3.1.A but the analyser computes `H(f) =
mean(y·exp(-j·2π·f·t))` per step, exposing both `|H|` and `arg(H)`. Tiny additional
code; significant accuracy gain.

#### 3.1.E — Random excitation + H1/H2 transfer function estimator

Play 5-10 s of band-limited Gaussian noise (band-limited to `[f_min, f_max]` covering
all modes of interest) at the actuator. Compute Welch-method FRF:
```
H1(f) = G_xy(f) / G_xx(f)         [unbiased when noise on output only]
H2(f) = G_yy(f) / G_yx(f)         [unbiased when noise on input only]
```
where `x` is calibration channel (input force proxy) and `y` is response channel.
Apply 3.1.A's half-power bandwidth analysis to the resulting H(f).

**Advantage.** ALL modes measured simultaneously in one ~10 s recording. Best-linear-
approximation property useful if any actuator nonlinearity exists.

**Disadvantage.** SNR-per-Hz is much lower than stepped sine (energy is spread over
the whole band). For very-high-Q narrow modes the FFT bin resolution (typically 1 Hz
with 1 s window × 8 averages over 8 s) is too coarse to resolve the bandwidth.
Acceptable for medium-Q midrange modes; inferior for low-frequency high-Q modes.

**Pianoid integration.** New `impulse_form: "random_band"` with sub-config:
`f_low_hz`, `f_high_hz`, `duration_ms`, `seed`, `crest_factor_target`. Post-processor
uses scipy.signal.csd / scipy.signal.welch. **Useful as a "second opinion" on
ESPRIT's broadband fit** — if ESPRIT and random-FRF agree on the mode set, confidence
is high; disagreement flags a stale calibration.

#### 3.1.F — Multi-sine (Schroeder-phased)

Pre-compute a periodic excitation `s(t) = Σ_i A_i · sin(2π·f_i·t + φ_i)` with
Schroeder phases `φ_i = -i(i-1)π/M` (minimal crest factor). Play 1-2 periods to settle,
then average L periods of the response. Per-frequency `H(f_i)` extracted by synchronous
detection (same lock-in math as 3.1.D).

**Advantage.** Frequencies `f_i` can be chosen exactly at the modes of interest +
between-mode probes (relevant for Stream 2!). Period-averaging gives stepped-sine SNR
without the per-step settling overhead. Total measurement time `L · 1/gcd(f_i)` —
typically 1-3 seconds for ~50 frequencies.

**Disadvantage.** Implementation complexity is the highest in this list. Optimal
phase / amplitude design is a small optimisation problem in itself. Best deferred
until 3.1.A and 3.1.B are operational.

**Pianoid integration.** New `impulse_form: "multisine"` with sub-config:
`frequencies_hz: [...]`, `amplitudes_db: [...]`, `n_periods_settle`, `n_periods_average`,
`schroeder_phase: bool`. The frequency list is computed by the **planner** (which knows
the ESPRIT chain center frequencies + the user-chosen between-mode probe points) and
written into the impulse_config. Post-processor synchronously detects each `f_i`.

### 3.3 Recommendation for Stream 1

**Ship 3.1.C (log-decrement cross-check) immediately as a free QC layer.** Zero new
measurement, two days of code, surfaces a real diagnostic (ESPRIT vs log-decrement
disagreement = mode contamination warning).

**Ship 3.1.A (stepped-sine bandwidth Q) as the first new measurement type.** This is
exactly what the user described, the textbook method, and integrates cleanly with the
Measurement-entity model. Phase 1 of any rollout.

**Defer 3.1.B (swept-sine) to Phase 2.** Modest additional value over 3.1.A; the
nonlinearity rejection is nice but not mission-critical. Add when Phase 1 is solid.

**Skip 3.1.D as a separate technique** — fold it into 3.1.A's post-processor as
"also extract phase". Free upgrade.

**3.1.E (random) and 3.1.F (multi-sine)** are research-grade; defer until / unless
the simpler techniques prove inadequate. 3.1.F is the natural carrier for Stream 2's
between-mode probes.

---

## 4. Stream 2 — Modal Mass Measurement Techniques

A reminder of why this matters: **modal mass scales the mode's contribution** in the
synthesis equation. In modal-superposition form,
```
y(t)  =  Σ_k  (φ_k(x_response) · φ_k(x_excitation) / m_k)  ·  q_k(t)
```
where `m_k` is modal mass, `φ_k` is mode shape, and `q_k(t)` is the modal coordinate
(driven by the input force). Today, Pianoid lumps the `φ²/m_k` factor into the
mode shape amplitude — works for replaying single-point excitation, but doesn't
*calibrate* the model. With calibrated `m_k`, multi-point excitation, sustain-pedal
re-excitation, and string-board coupling all become physically grounded.

### 4.1 Method matrix

| Method | Hardware needed | Per-mode cost | Accuracy | Implementation effort |
|---|---|---|---|---|
| **4.1.A — Mass loading (calibration mass)** | Known mass (10-50 g) physically attached at the response point | ~1 min per mass position (re-collect impulse, re-run ESPRIT) | Best in literature for modal mass; ±5-10% with care | LOW software (re-uses existing impulse pipeline); HIGH operator effort |
| **4.1.B — Between-modes steady-state probe (user's suggestion)** | None new | ~2-5 s per probe frequency, several probes per mode pair | ±10-30% relative-mass; depends on isolation of probe frequencies | MED-HIGH |
| **4.1.C — FRF residue extraction (SDOF curve fit, circle-fit)** | None new (re-uses stepped-sine or random data from Stream 1) | Free if 3.1.A or 3.1.E ran | ±10-20% per residue; standard EMA technique | MED |
| **4.1.D — Reciprocity check** | None new | 2 × per swap pair (existing impulse data) | Sanity check, NOT a primary measurement | LOW |
| **4.1.E — Driving-point mobility (drive AND measure same point)** | Probe accelerometer co-located with actuator (we already have calibration channel — qualifies if wired correctly) | Free with calibration channel | Direct extraction; ±5-15% | LOW-MED |

### 4.2 Per-method analysis

#### 4.1.A — Mass loading (the gold standard)

**Procedure.** Attach a **known small mass** `δm` (10-50 g, beeswax-mounted on the
soundboard at the measurement point) and re-measure. The mode `k` shifts in frequency
by approximately:
```
Δf_k / f_k  ≈  -(1/2) · δm · φ_k²(x_load) / m_k
```
Solve for `m_k` given measured `Δf_k`, applied `δm`, and the (unit-normalised) mode
shape value `φ_k(x_load)` at the load point (already extracted by ESPRIT).

**Why it works.** Adding mass at a point that participates strongly in mode `k` (i.e.
`φ_k(x_load)` is large) lowers `f_k` proportionally. Adding mass at a NODE of mode
`k` (`φ_k(x_load) ≈ 0`) doesn't shift `f_k` at all — confirming mode shape estimate
correctness and providing a clean control. Repeating for several mass positions
**over-determines** the modal mass, allowing a least-squares fit.

**Caveats.**
- Fundamental modes (low frequency, high modal mass) need disproportionately large
  mass to produce measurable shift. For a typical soundboard mode at 80 Hz with
  modal mass ~50 g, a 5 g sticker shifts frequency by ~5% — fine. For a mode with
  modal mass ~500 g a 5 g sticker shifts by 0.5% — at the noise floor of frequency
  estimation. Use larger mass for stiff modes.
- Mass coupling assumes `δm` does not interact with the dynamics (rigid attachment,
  no resonance of its own in the band of interest). Beeswax-mounted weights on a
  soundboard satisfy this for `δm < 50 g` and modes below ~3 kHz.
- Each new mass position is a **separate Measurement** in Pianoid's entity model
  (fresh acquisition, fresh scenarios). Already supported by the v2 entity layout —
  just create another Measurement, label it "Belarus + 10g at C5".

**Pianoid integration.** No new measurement type — just **multiple Measurements**
linked via metadata (`mass_load: {position: "C5", grams: 10.0}` field in
`measurement.json`). New analysis pipeline `modal_mass_from_loading.py` consuming a
**set** of {Measurement, ESPRIT result} pairs and the documented load metadata.

**Status as recommended technique.** **Highest-accuracy method; lowest software
effort; HIGH operator burden.** Ideal for a one-time calibration of a small set of
critical modes (the 12-20 most strongly-coupled modes of the soundboard) against
which the techniques in 4.1.B-E can be validated. Not appropriate for routine
re-measurement.

#### 4.1.B — Between-modes steady-state probe (the user's intuition, formalised)

**The user's words:** "emitting signal on the frequency in between two modes can give
idea about their relative masses." This is exactly correct. The math:

For a SDOF system the FRF is `H(f) = (1/m) / (ω_n² - ω² + 2jζω_n·ω)`. For a multi-DOF
system with well-separated modes, the FRF at point `j` driven at point `k` is:
```
H_jk(f)  =  Σ_n  (φ_n(j) · φ_n(k))  /  (m_n · (ω_n² − ω² + 2jζ_n·ω_n·ω))
```
**Off-resonance (`f` between two modes), the damping term is negligible** and the
real part dominates:
```
H_jk(f)  ≈  Σ_n  (φ_n(j)·φ_n(k) / m_n)  /  (ω_n² − ω²)              [|ω - ω_n| >> ζ·ω_n]
```

Pick a frequency `f_probe` between modes `k` and `k+1`. The two terms in the sum
that dominate are `n=k` (positive, since `ω_probe > ω_k`) and `n=k+1` (negative,
since `ω_probe < ω_{k+1}`). Higher and lower modes contribute small "residuals" that
can be lumped into upper/lower residue terms (`U` and `L` in Ewins' notation):

```
H_jk(f_probe)  ≈  (R_k / (ω_k² − ω_probe²))  +  (R_{k+1} / (ω_{k+1}² − ω_probe²))  +  L  +  U
```

where the **residue** `R_n = φ_n(j) · φ_n(k) / m_n`. With the mode shapes already
known (ESPRIT) and the residence frequencies & damping known (ESPRIT), and several
probe frequencies between consecutive mode pairs, the residues form an **over-
determined linear system** solvable by least-squares. The ratio `R_k / R_{k+1}` gives
the **relative modal mass ratio** `m_{k+1}/m_k` (modulo the known mode shape ratio).

**Number of probes.** For `M` modes, classical FRF curve-fitting needs ~3·M FRF
samples to over-determine the system. Practical recipe:
- One probe at the local minimum between each consecutive mode pair (`(M-1)` probes)
- One probe at each mode's resonance (`M` probes — these also yield Q from 3.1.A)
- A few probes far below `f_1` and far above `f_M` to constrain `L` and `U`

For a piano soundboard with say 30 well-resolved modes in 30-3000 Hz, that's ~70 probe
frequencies. At 0.5 s dwell each = 35 s of measurement. Very cheap.

**Caveats.**
- Requires good Q (i.e. damping must be small enough that the off-resonance approximation
  holds). For Q < 5 the SDOF-superposition approximation degrades and the residues are
  noisy.
- Requires good mode shape estimates. If ESPRIT's mode shapes are wrong, the residues
  are wrong by the same amount — the modal mass extraction is downstream of ESPRIT.
- The "L" and "U" residual terms (out-of-band modes) are a free parameter. When the
  measured frequency band is wide and tightly-fit, L+U converge toward DC stiffness +
  high-frequency mass — but they ARE a fit parameter and will absorb modeling errors.

**Pianoid integration.** This naturally rides on top of 3.1.A or 3.1.F — `stepped_sine`
with the frequency list set to the resonance + between-mode probe frequencies. Post-
processor runs both Q-extraction (per resonance step) and residue extraction (per off-
resonance step). New analysis tab in the Modal Adapter UI: "Modal masses (relative)"
showing the inferred `m_n / m_1` ratios with uncertainty bars from the LS fit.

**Status.** **HIGH VALUE, MED EFFORT, NO new hardware.** This is the technique most
worth shipping after the basic stepped-sine Q infrastructure exists. It directly
implements the user's intuition.

#### 4.1.C — FRF residue extraction (SDOF circle-fit, classical EMA)

The "industry standard" approach, documented in Ewins, Heylen, Maia, and every modal-
analysis textbook. Given a measured FRF `H(f)` over a wide band (from any of 3.1.A,
3.1.B, 3.1.E, 3.1.F), fit each resonance peak with a **single-degree-of-freedom (SDOF)
model**:
```
H_n(f)  =  R_n  /  (ω_n² − ω² + 2jζ_n·ω_n·ω)  +  L_n  +  U_n
```
**Circle-fit method (Kennedy-Pancu).** Plot `H(f)` in the complex plane near `f_n` —
it traces approximately a circle (Nyquist diagram). Fit the circle; circle diameter is
proportional to `R_n / (2 ζ_n ω_n²)`; circle position encodes `L_n + U_n`. Combined with
the already-known `ω_n` and `ζ_n`, the residue `R_n` (and hence `m_n` given mode shape)
falls out.

**Strengths.** Very robust to noise — circle fitting tolerates 20-30% point-wise FRF
error and still recovers a clean residue. Standard, well-validated, lots of MATLAB /
Python code exists (scipy `signal.modal_parameters` if available, or a custom 30-line
implementation).

**Weaknesses.** Assumes well-isolated modes. When two modes overlap (`|f_{k+1} - f_k| <
3·max(BW_k, BW_{k+1})`), the circle gets squashed and residues are biased. Multi-DOF
generalisations (Rational Fraction Polynomial — RFP) handle this but cost a lot more
implementation effort.

**Pianoid integration.** Pure post-processor over the existing `H(f)` from any
sustained-excitation measurement. Could even run on the FFT of the existing impulse
response (poor SNR but free). New analysis module `modal_residue_circlefit.py`. Output
keyed by chain ID into the existing tracking output.

**Status.** **Natural follow-on to 3.1.A.** Once the FRF exists, circle-fit costs ~50
lines of code and gives a per-mode residue with uncertainty.

#### 4.1.D — Reciprocity (cross-check, not primary measurement)

Maxwell-Betti reciprocity: `H_jk(f) = H_kj(f)` for any pair `(j, k)` — the FRF from
driving at j to measuring at k equals the FRF from driving at k to measuring at j. **Not
a way to MEASURE modal mass**, but a powerful way to **validate** that the system is
linear and the calibration is correct.

For Pianoid: pick two excitation positions (e.g. C2 and C6), measure FRF in both
directions (this requires actually moving the actuator, NOT a free test). Compare.
Disagreement ⇒ nonlinearity, calibration drift, or coupling to the suspension /
mounting. This is a **once-per-physical-rig sanity test**, not a routine measurement.

**Pianoid integration.** Two existing Measurements at swapped positions; new analysis
script comparing their cross-FRFs and reporting deviation. Trivial code, valuable QC.

#### 4.1.E — Driving-point mobility (the under-utilised free win)

A driving-point FRF is one where the response is measured AT the same point as the
excitation. **Pianoid's calibration channel ALREADY captures this** — the calibration
microphone / accelerometer is co-located with the actuator. So `H(f) = X_calibration(f)
/ F_input(f)` IS the driving-point mobility, modulo the input force estimation.

The classical driving-point property: at resonance `f_n`, the imaginary part of the
mobility (`Im(H/jω) = Im(H)/ω`) reaches a peak whose height is `1 / (2 ζ_n ω_n m_n)`,
giving **modal mass directly** when ζ_n and ω_n are already known.

**Caveat.** Requires the calibration channel to be properly **calibrated to engineering
units** (m/s per Newton, or the equivalent). Pianoid's current calibration channel is
calibrated in ARBITRARY units (the absolute scale is unknown — only ratios matter).
Promoting it to absolute calibration requires a **one-time** calibration against a
known impedance head or a reference accelerometer — possible if the user has access
to a reference standard, otherwise this method is reduced to RELATIVE modal masses
(same as 4.1.B).

**Pianoid integration.** No new measurement; needs the calibration channel scale factor
in `audio_config.json` (one new field: `calibration_units_per_volt`). Post-processor
extracts driving-point mobility and applies the modal-mass formula at each ESPRIT
resonance.

**Status.** **Should ship as a parallel analysis whenever stepped-sine or sweep data
exists.** If the user can provide a one-time absolute calibration of the calibration
channel, this becomes the cheapest route to absolute (not just relative) modal mass.

### 4.3 Recommendation for Stream 2

**Ship 4.1.B (between-modes residue extraction) as the primary modal-mass technique.**
This is the user's stated intuition, cheap to implement on top of 3.1.A's stepped-sine
infrastructure, and gives **relative** modal masses without any new hardware. Ratios
of modal masses (along with the already-extracted mode shapes) is enough to scale the
synthesis engine correctly across modes.

**Ship 4.1.E (driving-point mobility) as a free parallel analysis.** Same data, ~30
lines of post-processor. Yields absolute modal mass IF the calibration channel is
absolutely calibrated; relative modal mass otherwise.

**Ship 4.1.C (circle-fit) as a cross-check** of 4.1.B. Two independent ways to extract
the residue from the same FRF — agreement = confidence; disagreement = "the SDOF
approximation is breaking down at this mode pair, look closer."

**Defer 4.1.A (mass loading) to a one-time validation campaign.** Demands operator
hardware and time, but gives the literature-standard accuracy. Run it ONCE per
physical instrument as the absolute calibration anchor, then use 4.1.B/C/E for routine
re-measurement.

**Defer 4.1.D (reciprocity)** to an ad-hoc QC ritual when a physical-rig change has
occurred. No need to put it in the routine pipeline.

---

## 5. Stream 3 — Pianoid-Specific Feasibility

Per-technique evaluation against Pianoid's current infrastructure.

### 5.1 Audio driver capability

| Capability needed | SDL3 driver supports today? | New work? |
|---|---|---|
| Sustained sine tone for 0.5-2 s at fixed frequency | YES — recorder already plays multi-second signals | None |
| Long compound signal (e.g. concat of 50 stepped-sine bursts = ~30 s) | YES — `_generate_complete_signal` builds an arbitrary numpy array; SDL3 streams it | None |
| Continuous sine sweep (Farina ESS) for 1-5 s | YES — same arbitrary-buffer path | None |
| Band-limited Gaussian noise for 5-10 s | YES — pre-compute filtered noise, hand to SDL3 | None |
| Multi-sine (sum of pre-computed sinusoids) | YES — pre-compute the sum array | None |
| Two-channel simultaneous output (e.g. one tone left, sweep right) | NEEDS CHECK — `measure_room_response_auto_multichannel` is single-output today | LOW — `sdl_audio_core` supports multi-channel out, just need to expose it |

**Conclusion.** Pianoid's audio driver is essentially **already capable** of every
playback waveform in this proposal. The recorder needs new pulse-form generators
(~50 LOC each) but no new C++ layer.

### 5.2 Capture pipeline

The current capture pipeline (`SignalProcessor` → cycle-extract → align → average) is
specialised for **short-impulse** measurements. Sustained-excitation measurements
(stepped sine, sweep, noise, multi-sine) need a **parallel pipeline**:

| Pipeline stage | Today (impulse) | New (sustained) |
|---|---|---|
| Cycle extraction | onset-detect calibration channel | per-step windowing OR sweep deconvolution |
| Cycle alignment | circular shift to match reference | not needed (continuous capture) |
| Mean averaging | mean across surviving cycles | per-frequency averaging (lock-in) OR Welch FRF |
| Truncation | Hann-fadeout window | not needed |

This is **a separate processor** (`SustainedExcitationProcessor`) that lives next to
`SignalProcessor` in the measurement subsystem. It's parameterised by the
`impulse_form` value so the recorder picks the right one. Effort estimate: ~400-600
LOC for the first sustained type (stepped_sine), ~150 LOC for each subsequent type.

### 5.3 New measurement scenarios in Collection UX

The Phase 2b Collection subpanel already has the **Section C: Impulse** with an
`impulse_form` Select dropdown (`sine | square | voice_coil`). New entries:

| New impulse_form | Section C UI additions | Settings persisted to impulse_config.json |
|---|---|---|
| `stepped_sine` | sub-block: f_start/f_end/n_steps/dwell_ms/log-or-linear; "auto-target ESPRIT chains" button | `stepped_sine_config: {f_start_hz, f_end_hz, n_steps, dwell_ms, sweep_axis: "linear" | "log", target_chain_ids: [...]}` |
| `swept_sine` | sub-block: f_start/f_end/duration_ms/sweep_type | `swept_sine_config: {f_start_hz, f_end_hz, sweep_duration_ms, sweep_type, fade_ms}` |
| `random_band` | sub-block: f_low/f_high/duration/seed | `random_band_config: {f_low_hz, f_high_hz, duration_ms, seed}` |
| `multisine` | sub-block: frequencies list editor; "auto-fill from chains" button | `multisine_config: {frequencies_hz: [...], amplitudes_db: [...], n_periods_settle, n_periods_average}` |
| `between_modes_probe` | sub-block: source chain set; auto-computes probe frequencies as midpoints | `between_modes_probe_config: {source_chain_set: "current_tracking", n_probes_per_pair, dwell_ms}` |

**Critical UI question.** Should these be additional `impulse_form` values OR a new
top-level "Measurement type" radio group? The user's prior decision to put a
"Measurement type" radio in Q4-merge work argues for the latter — the techniques here
are conceptually a different KIND of measurement (steady-state FRF acquisition), not
a different pulse shape. **Recommendation:** add a new field
`measurement_type: "impulse" | "stepped_sine" | "swept_sine" | "random" | "multisine"
| "between_modes"` to `impulse_config.json`, with `impulse_form` retained as a
sub-field of the `impulse` measurement type. This keeps the existing impulse-pipeline
fully backward-compatible.

### 5.4 New processing pipelines

| Pipeline | Consumes | Produces | New module |
|---|---|---|---|
| Log-decrement Q cross-check (3.1.C) | Existing averaged IR | Per-chain `Q_logdec` | `modal_adapter/qc/log_decrement.py` |
| Stepped-sine Q (3.1.A + 3.1.D) | New stepped-sine recording + calibration | Per-target `f_n_refined`, `Q`, `BW_-3dB`, phase residual | `modal_adapter/sustained/stepped_sine_q.py` |
| Sweep deconvolution (3.1.B) | New swept recording + calibration | Bandpassed IR per band | `modal_adapter/sustained/sweep_deconv.py` |
| Random FRF (3.1.E) | New random recording + calibration | H(f) via Welch | `modal_adapter/sustained/random_frf.py` |
| Multi-sine FRF (3.1.F) | New multisine recording + cal | H(f_i) per tone | `modal_adapter/sustained/multisine_frf.py` |
| Residue extraction (4.1.B circle-fit + LS) | Any of the above H(f) + ESPRIT chains | Per-chain residue, relative modal mass, uncertainty | `modal_adapter/mass/residue_extraction.py` |
| Mass-loading inversion (4.1.A) | Set of {Measurement, ESPRIT} pairs + load metadata | Per-chain absolute modal mass | `modal_adapter/mass/mass_loading.py` |
| Driving-point mobility (4.1.E) | Any sustained recording + cal scale factor | Per-chain absolute modal mass | `modal_adapter/mass/driving_point.py` |
| Reciprocity check (4.1.D) | Two impulse Measurements at swapped positions | Linearity / calibration deviation report | `modal_adapter/qc/reciprocity.py` |

### 5.5 Minimum-viable additional measurement type

If only ONE new measurement type ships first, it should be **stepped_sine + the
between-modes probe variant of it**, because:

1. It's exactly what the user described.
2. It's the **highest-SNR** technique available (pure tone in one bin).
3. It enables BOTH Stream 1 (Q from half-power BW) AND Stream 2 (relative modal mass
   from off-resonance amplitude) from a SINGLE recording type.
4. The recorder code is the simplest of any sustained-excitation type.
5. The post-processor (lock-in detection per step) is well-understood signal processing.
6. The result (one Q + one relative-mass per ESPRIT chain) is exactly the scalar
   parameters needed to upgrade the synthesis engine's per-mode parameters.

The 4.1.A mass-loading should be **piloted in parallel** by the user (purely a
measurement-protocol exercise, no new code beyond a metadata field) to provide the
absolute calibration anchor for the relative measurements.

---

## 6. Stream 4 — Recommended Sequence (If Approved)

Six potential phases, sequenced by value-per-effort. The phasing assumes Pianoid's
existing Measurement-entity model continues unchanged.

### Phase 1 — Free QC layers (no new measurements) — ~3 days

- Implement **3.1.C** log-decrement Q cross-check on existing averaged IRs. Surface as
  a Tracking-section QC chip.
- Implement **4.1.D** reciprocity check (consumes pairs of existing impulse
  Measurements). Surface as an analysis report tab.
- Implement **4.1.E** driving-point mobility extraction (consumes existing impulse
  data + calibration channel). Surface absolute modal mass IF the user provides a
  calibration channel scale factor; otherwise show "relative modal mass × k" with k
  as the unknown calibration constant.

**Outcome.** Three independent extra views on data Pianoid already has. Zero new
measurement types; zero new audio capability. Validates the analysis-side framework
before committing to new acquisition work.

### Phase 2 — Stepped-sine bandwidth Q (the user's primary suggestion) — ~2 weeks

- Add `measurement_type: "stepped_sine"` to `impulse_config.json` schema. Backward-
  compatible default `"impulse"`.
- Build `SustainedExcitationProcessor` framework (parallel to `SignalProcessor`) with
  the stepped-sine specialisation as the first concrete instance.
- New `stepped_sine_q.py` post-processor: per-target-chain, find peak frequency,
  half-power bandwidth, Q, phase residual.
- New Section-C UI sub-block for stepped-sine config; "Auto-target current Tracking
  chains" button.
- New analysis tab "Per-mode Q (stepped-sine)" alongside existing Tracking — shows
  ESPRIT vs stepped-sine Q comparison per chain with disagreement chips.

**Outcome.** First sustained-excitation measurement type shipped end-to-end. User can
measure Q with mode-isolated SNR for any chain in a Tracking result.

### Phase 3 — Between-modes probes + relative modal mass (4.1.B + 4.1.C) — ~2 weeks

- Extend stepped-sine config UX with "between-modes probes" mode (auto-computes probe
  frequencies as midpoints between consecutive Tracking chains).
- New `residue_extraction.py` post-processor: solve LS system for per-chain residue
  from FRF samples + ESPRIT mode shapes + ESPRIT frequencies/dampings. Output
  per-chain residue with covariance (uncertainty).
- Implement **4.1.C** circle-fit as a parallel residue extractor for cross-check.
- New analysis tab "Modal masses (relative)" — bar chart of `m_n / m_1` with error
  bars; chi-squared goodness-of-fit per mode; flag chains where circle-fit and LS
  residue disagree by more than 2σ.

**Outcome.** First measurement-side route to **modal mass ratios** in Pianoid. Enables
proper scaling of the synthesis engine's per-mode coupling.

### Phase 4 — Mass-loading absolute calibration anchor — ~3 days code + operator time

- One new field on `measurement.json`: `mass_load: {position: str, grams: float} |
  null`. UI shows it as an optional field in Section A (General).
- New `mass_loading.py` post-processor: given a SET of Measurements with consistent
  ESPRIT chains and varying `mass_load`, solve for absolute modal mass per chain.
- New analysis tab "Modal masses (absolute)" — per-chain absolute mass with confidence
  intervals from the multi-load LS fit.

**Operator burden.** User physically attaches known mass to the soundboard at
documented position, records a new Measurement, repeats for 3-5 mass / position
combinations. ~30-60 min total operator time per instrument calibration. No
recurring cost — once measured, the absolute calibration anchors all future
Phase 3 relative measurements.

**Outcome.** Fully calibrated absolute modal mass per chain. The synthesis engine can
now be scaled in physical units.

### Phase 5 — Swept-sine + random-FRF (alternative SNR characterisations) — ~2 weeks

- Implement **3.1.B** swept-sine with Farina deconvolution.
- Implement **3.1.E** random-band FRF.
- Both feed the same residue / circle-fit / mobility analysis pipelines from Phase
  3 / 4.

**Outcome.** Three independent FRF acquisition methods (stepped, sweep, random),
allowing cross-validation. Especially valuable for high-Q bass modes where stepped-sine
is slow and for medium-Q midrange modes where sweep is fastest.

### Phase 6 — Multi-sine optimised excitation — ~2-3 weeks

- Implement **3.1.F** with Schroeder-phase design.
- Use case: simultaneous measurement of all chain frequencies + between-mode probes in
  a single 2-3 s recording. The "Concorde" of modal measurement — fast, very high
  SNR, requires the most up-front setup.

**Outcome.** Best total measurement time for routine re-measurement of a known mode set.

### Calendar

| Phase | Effort | Cumulative wall-time | Gates |
|---|---|---|---|
| 1 | 3 days | week 1 | QC layer trustworthy on legacy data |
| 2 | 2 weeks | week 3 | Stepped-sine Q matches log-decrement Q within 10% |
| 3 | 2 weeks | week 5 | Relative modal masses self-consistent across probe sets |
| 4 | 3 days + operator time | week 6 | Mass-loading absolute anchor matches Phase 3 ratios within 15% |
| 5 | 2 weeks | week 8 | All three FRF acquisition methods agree on Q within 5% on a test mode |
| 6 | 2-3 weeks | week 11 | Multi-sine measurement reproduces stepped-sine Q within 5% in 1/10 the time |

**Total ~10-11 weeks** for the full programme. Phases 1-3 + 4 (~6 weeks) cover 90%
of the practical value.

---

## 7. Open Questions for User

These should be resolved BEFORE any implementation work begins. Decisions affect
schema, UX, and effort estimates.

### 7.1 Priority and scope

1. **Which Stream is the primary driver — Q-factor accuracy or modal-mass calibration?**
   Both are useful, but the user's note suggests Q-factor first ("frequency sweeping
   around the frequency of the mode"). Confirm priority order, OR confirm "ship both
   in the same campaign as Phase 2 + Phase 3 in series".

2. **Is absolute modal mass needed, or is relative modal mass enough for the
   synthesis goal?** Relative is much cheaper (no calibration anchor, no mass-loading).
   Absolute requires either Phase 4 (mass loading) OR access to a calibrated reference
   accelerometer for one-time mobility calibration.

3. **What accuracy target?** For Q-factor: ±5% is achievable with stepped-sine + 1 s
   dwell, ±2% with multi-sine. For relative modal mass: ±10% is what circle-fit
   typically delivers; ±5% with mass-loading. State the target so we know how much
   averaging / probe density is needed.

### 7.2 Hardware / measurement setup

4. **Is the calibration channel sensor calibrated to engineering units?** If yes (or
   a one-time calibration is feasible), Phase 1's driving-point mobility (4.1.E) yields
   absolute modal mass for free. If not, Phase 4 mass-loading is the only absolute path.

5. **Is the user willing to perform mass-loading measurements?** Phase 4's accuracy
   advantage is real, but it requires physical mass attachment + careful recording at
   ~5 mass positions per instrument. ~1 hour total. Yes/no determines whether Phase 4
   is in scope.

6. **What modes are the priority targets?** "All ESPRIT chains" is a lot of
   measurement time. "The 12-20 strongest soundboard modes" is more practical for an
   initial campaign. The stepped-sine planner needs a target list.

### 7.3 Data model / UX

7. **`measurement_type` as a top-level field, or `impulse_form` extended?** §5.3
   recommends top-level `measurement_type` so the existing impulse pipeline stays
   structurally separate from the new sustained pipelines. Confirm or push back.

8. **Persistent vs ephemeral analysis output.** Should each new analysis (Q-cross-
   check, residue extraction, etc.) produce a new file under `modal_adapter/{name}/`
   in the Project, mirroring the existing `esprit/`, `tracking/`, `feedin/` pattern?
   Recommend yes (consistency); flag if user has a different preference.

9. **One-Measurement-many-types or one-Measurement-one-type?** Current Measurement
   model is one acquisition session = one Measurement. A Q-stepped-sine sweep of a
   chain set is a separate acquisition session — should it be a separate Measurement
   (recommended, fits the entity model) or a "stepped-sine annex" inside an existing
   Measurement? The latter is awkward and we recommend AGAINST it.

10. **Where does the residue / modal-mass output get consumed downstream?** Today's
    feedin path maps mode shape × excitation pitch → coupling coefficient. The new
    `m_n` data needs a target consumer. Options:
    - Replace today's mode-shape-only normalisation with `φ²/m_n` normalisation in
      the preset injector (cleanest).
    - Store `m_n` as side-channel data and let the user manually integrate it (least
      invasive but least valuable).
    - Wire `m_n` into the engine's per-mode `mass_per_mode` parameter (if such a
      parameter exists; needs verification against the engine's parameter system).
    User direction needed.

### 7.4 Process

11. **Multi-author vs single-thread?** Phase 2-6 each fit cleanly into a `/dev`
    workflow chunk. Phases 2 and 3 have a hard sequential dependency (residue
    extraction needs stepped-sine recordings). Phase 4 can run in parallel with Phase
    3. Phases 5 and 6 are post-MVP.

12. **Validation approach.** Each new technique needs a validation criterion. The
    cheapest validation is **internal consistency** (different methods on the same
    data should agree). The most expensive but most rigorous is **external
    reference** (compare modal masses to FEM model output, compare Qs to literature
    for similar instruments). Which standard does the user want applied?

---

## 8. References

### Textbooks (canonical)

- Ewins, D.J. (2000). *Modal Testing: Theory, Practice and Application* (2nd ed.).
  Research Studies Press. **THE reference for FRF-based modal extraction**, circle-fit
  (chapter 4), residue extraction (chapter 5), driving-point measurements (chapter 6).
- Heylen, W., Lammens, S., Sas, P. (2007). *Modal Analysis Theory and Testing*.
  Katholieke Universiteit Leuven. Definitive treatment of stepped-sine, swept-sine,
  random, and multi-sine excitation strategies.
- Maia, N.M.M., Silva, J.M.M. (eds.) (1997). *Theoretical and Experimental Modal
  Analysis*. Research Studies Press. Mass-loading and modal-mass calibration
  (chapter 9), reciprocity (chapter 4).
- Fletcher, N.H., Rossing, T.D. (1998). *The Physics of Musical Instruments* (2nd ed.).
  Springer. Piano-specific modal-mass values (soundboard chapter 12) — useful sanity-
  check ranges for Pianoid output.

### Web references

- [Half-power bandwidth method (Tom Irvine, vibrationdata.com)](https://www.vibrationdata.com/tutorials2/half_power_bandwidth.pdf)
  — derivation, validity range, common pitfalls.
- [Euphonics §10.5 — Experimental modal analysis](https://euphonics.org/10-5-experimental-modal-analysis/)
  — musical-acoustics-focused intro to half-power BW, modal extraction.
- [Estimating Damping Values Using the Half Power Method (ISR Technical)](https://www.isrtechnical.com/media/tech-briefs/estimating_damping_values.pdf)
  — practical guidance on resolution / SNR.
- [A correction of the half-power bandwidth method for estimating damping (Wang/Liu)](https://www.researchgate.net/publication/271873981_A_correction_of_the_half-power_bandwidth_method_for_estimating_damping)
  — corrected formula valid up to ζ ≈ 0.3.
- [Spectral Dynamics — Sine test methodologies (swept / stepped / dwell)](https://www.spectraldynamics.com/support/technical-library/understanding-sine-test-methodologies-swept-sine-stepped-sine-and-resonance-search-and-dwell)
  — operational comparison.
- [Crystal Instruments — MIMO Stepped Sine Testing Technique](https://www.crystalinstruments.com/mimo-stepped-sine-testing-technique)
  — MIMO and dwell-time considerations.
- [Data Physics — Modal testing with shaker excitation](https://dataphysics.com/blog/modal-analysis/modal-analysis-and-testing-with-shaker-excitation/)
  — practical SNR / windowing recommendations for random-noise modal testing.
- [Vibration Research — Modal (SIMO) vs. Sine Testing for Resonance](https://vibrationresearch.com/blog/modal-simo-sine-testing-resonance/)
  — when to choose which.
- [Sherman-Morrison-Woodbury — Removing mass loading effects of multi-transducers (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1270963819306169)
  — corrections for sensor mass-loading bias.
- [Mass-stiffness change method for scaling of operational mode shapes](https://www.researchgate.net/publication/241541148_Mass-stiffness_change_method_for_scaling_of_operational_mode_shapes)
  — primary reference for mass-loading modal-mass extraction.
- [Farina, A. — Simultaneous measurement of impulse response and distortion with a swept-sine technique](https://www.melaudia.net/zdoc/sweepSine.PDF)
  — the canonical ESS reference.
- [A comparison among modal parameter extraction methods (Discover Applied Sciences)](https://link.springer.com/article/10.1007/s42452-019-0806-8)
  — head-to-head benchmark of circle-fit, RFP, ERA, ESPRIT.
- [HP Application Note 243-3 — The Fundamentals of Modal Testing](https://rotorlab.tamu.edu/me459/APP%20Note%20243-3%20The%20Fundamentals%20of%20Modal%20Testing.pdf)
  — clearest single-document treatment of the residue / modal-mass relationship.

### Pianoid internal docs (for context)

- [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../guides/MODAL_ADAPTER_GUIDE.md) — current
  ESPRIT pipeline, project layout, Collection UX.
- [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../modules/pianoid-middleware/MODAL_COLLECTION.md)
  — Measurement entity REST surface, recorder configuration overrides.
- [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](modal-adapter-measurement-entity-2026-05-10.md)
  — Measurement entity design (the structural hook every new measurement type rides on).

---

**END OF PROPOSAL.** Awaiting user direction on the §7 open questions before any
implementation work is scheduled.
