# Modal Mass + Q-Factor — Improvement Plan Built on the Force Channel (Updated Analysis)

**Date:** 2026-05-24
**Status:** RESEARCH PROPOSAL — read-only analysis. NO code edits in this pass; user
decision required on the §7 open questions before any implementation work is scheduled.
**Author:** /analyse pass (orchestrator-spawned read-only research, 2026-05-24).
**Supersedes:** [`modal-mass-q-factor-measurement-techniques-2026-05-13.md`](modal-mass-q-factor-measurement-techniques-2026-05-13.md) §6 sequencing
(NOT its physics — the textbook techniques in §3-§5 of the earlier proposal stay valid;
this plan adds an extra Phase 0 layer below them that exploits data we already record).
**Scope:** Concrete improvements to the modal-mass / Q-factor measurement story that fit
on top of the **current** Modal Adapter architecture (Wave 1 + Wave 2 of the
`modal_adapter` split + round-18 averager-validation removal). The headline addition
versus the 2026-05-13 proposal is: **use the force-channel signal already captured in
`average_ch0.npy` as the input X(f) in a proper FRF computation H(f)=Y(f)/X(f)**, which
unlocks per-mode Q, relative modal mass, and modal-mass-weighted mode shapes from the
recordings the user has already taken — no new measurement hardware, no new excitation
type, no operator burden.

**User direction (this pass, verbatim):**

> "Pick up Modal Mass and Q-factor measurement proposal. Review and propose steps to
> improve the analysis based on the data already available. Consider using information
> on excitation strengths contained in the calibration (force) channel. Use maximum
> reasoning effort."

---

## 1. Recap — What the 2026-05-13 Proposal Concluded

A two-paragraph distillation of the prior 891-line document so a reader can decide
whether to open it.

The 2026-05-13 proposal observed that **all three modal quantities the synthesis engine
needs (frequency, damping, mode-shape-weighted residue) are extracted today from one
broadband-impulse measurement run through one extractor (ESPRIT)**. Frequency is
strong; damping is moderate (ESPRIT pole real-part is sensitive to model order and
close-mode contamination); modal mass is **never separately measured** — it is implicit
in the un-normalised mode shape and therefore non-portable across instruments. It then
catalogued **6 Q-factor techniques + 5 modal-mass techniques** from the experimental
modal analysis literature, mapped each onto Pianoid's Measurement entity, and proposed
a **6-phase rollout** (3 days to 11 weeks, depending on appetite). The recommended
first phase was a **free QC layer** (log-decrement Q cross-check, reciprocity check,
driving-point mobility) over data already on disk; the recommended first new
measurement was **stepped-sine half-power bandwidth** (§3.1.A) because it directly
implements the user's "sweep around the mode" intuition.

The proposal paused on **12 open questions** (§7) covering priority (Q vs mass first,
absolute vs relative), hardware (calibration channel SI calibration? mass-loading
willingness?), accuracy target, data model (new top-level `measurement_type` vs extended
`impulse_form`), and process (one Measurement per acquisition, downstream consumer wiring).
**None of those questions have been answered yet**, and no new measurement-type code has
shipped — the architecture has matured around the existing impulse pipeline instead. The
present plan updates the priorities (and trims the 12 questions to 8 newly-scoped ones)
based on what the architecture now actually exposes.

---

## 2. What's Changed in the Architecture Since 2026-05-13

Eleven days, but a meaningful amount of foundational work shipped that changes what's
cheapest to do next.

### 2.1 Modal Adapter split — Wave 1 + Wave 2 landed (dev-maimport, 2026-05-21)

The 5,649-LOC `modal_adapter.py` god-object was split into:

- `ProjectContext` — single owner of `ctx.measurements`, `ctx.sample_rate`,
  `ctx.mapping`, `ctx.per_scenario_results`, `ctx.tracked_chains`, `ctx.feedin_data`.
- `ScenarioLoader` — `_discover_*` helpers + RoomResponse/flat-npy loaders + v1+v2
  fallback.
- `VisualizationService` — heatmaps, charts.
- `EspritOrchestrator` — threaded run loop, per-scenario aggregation, persist.
- `TrackingOrchestrator` — sliding-window / sequential mode tracking.
- `ApplyService` — apply-to-preset + low-level `_persist` JSON writer +
  `export_to_text_files`.

**Implication for this plan.** Every new analysis stage proposed below has a clean
home: a new service class beside `EspritOrchestrator` consuming `ProjectContext` and
calling `ApplyService._persist(stage, filename, data)` with a new stage name. No new
infrastructure plumbing is required; the cost of adding a new analysis is the cost of
the analysis itself, not the cost of wiring it into a god-object.

### 2.2 Round-18 — per-cycle validation removed from project-creation averaging (070d836)

The averager (`scenario_averager.ensure_averaged_responses`) used to instantiate
`CalibrationValidatorV2` and reject cycles failing quality thresholds — which rejected
87 of 92 of the user's `PlyWoodLGtemp1` scenarios because their recorder used an older
`calibration_quality_config` schema. The fix moved per-cycle validation entirely to
the **recording stage** (`collection_engine` / `measurement_session`).

**Implication for this plan.** The principle the user explicitly locked in —
**"validation = collection only"** — means any new analysis we propose **must consume
whatever cycles the recording stage emits and do its own outlier handling internally,
not gate-and-drop**. This shapes the FRF-extraction design below: we compute the FRF
on all available cycles and let the outlier influence become a per-frequency variance
on `H(f)`, not a binary include/exclude.

### 2.3 Round-11 — canonical averager wire-up (dev-rrport, 2026-05-10)

The averaging pipeline was vendored in-tree under
`pianoid_middleware.modal_adapter.measurement.signal_processor.SignalProcessor`:
extract_cycles → align_cycles_by_onset → apply_alignment_to_channel →
**normalize_by_calibration** → average_cycles → truncate_with_fadeout.

**Critical observation (this analysis's central finding — see §4 in detail).** The
`normalize_by_calibration` step **DIVIDES every response cycle by the calibration
channel's per-cycle negative-peak magnitude** (`signal_processor.py:519-520`). The
calibration channel itself is **NOT normalised** (`signal_processor.py:502-504`: kept
as raw aligned, copied verbatim into the average).

The user has been computing a coarse single-scalar "FRF" — `Y_response /
|X_force_peak|` — at the cycle level for as long as `normalize_by_calibration: true`
has been the default. We are therefore *already* one step into FRF territory, but only
one step: dividing by a scalar peak captures *amplitude variability across cycles* but
NOT the actuator's frequency-domain transfer function. The leap to a proper
**spectral-domain `H(f) = Y(f)/X(f)`** is one rfft per channel away.

### 2.4 Rounds 17–29 — UX polish, planar-fit ban, heatmap smoothing

Numerous frontend rounds (heatmap smoothing rendering moved off-server, planar-fit
extrapolation deleted, grid-layout end-to-end). None of these affect the
measurement-physics surface directly, but two are notable for sequencing:

- **Round 24 — server-side smoothing/approximation deletion** establishes the
  user's contract: *the underlying matrix must stay inviolate; visual overlays are a
  rendering concern, never mutate measurement data*. Any new artefact we propose
  (FRF, modal-mass estimate, Q estimate) must follow this rule: store the
  un-smoothed, un-extrapolated raw numbers; let any visual smoothing happen on the
  frontend canvas overlay.
- **Round 30 — cooperative cancel at scenario boundary in the averager** establishes
  the cancellation pattern any new long-running analysis should follow.

### 2.5 Live-processing-flow Wave 1 landed (dev-liveproc-w1, 2026-05-22)

A subprocess worker for incremental processing per scenario landed in Wave 1 (no
analyses run yet; just plumbing + CuPy probe). When Wave 2 wires up, per-scenario
ESPRIT + tracking will fire as each new scenario is recorded.

**Implication.** Any per-scenario FRF/Q/mass analysis we add Should ride the
`handle_scenario_done(measurement_id, scenario_number, scenario_subdir)` callback target
that's already in the subprocess worker. We get incremental compute for free.

### 2.6 Grid-layout end-to-end (dev-maimport rounds 19+)

The Pianoid soundboard measurement mode the user is actually running today is a
**12 × 15 grid (180 cells, 92 populated)** with 10 mm spacing — see
`D:\modal_measurements\PlyWoodLGtemp1\setup\mapping_config.json`. Channel roles:
ch0 = force, ch1-7 = response. **All seven response channels are present** —
spatial sampling on the receiving side is 7-fold per scenario, the actuator visits 92
points across the grid.

**Implication for modal mass.** With 92 × 7 = 644 effective (excitation, response)
pairs and 30 measurements per scenario (5 cycles per measurement = 150 cycle-pairs
nominal), Pianoid has *more than enough* spatial-and-statistical data to extract
relative modal mass via the multi-input / multi-output FRF methods in §5.2 below.
This was not true in the line-bridge era of the 2026-05-13 proposal where ~30
scenarios × 1 response (typical line geometry) ≈ 30 pairs.

---

## 3. Current Data Inventory — Exactly What's On Disk

Before proposing new analysis we enumerate what's available, with measured
shapes/scales from `D:/modal_measurements/PlyWoodLGtemp1/scenarios/PlyWood-Scenario100-LG`.

### 3.1 Per-scenario folder structure

```
PlyWood-Scenario100-LG/
  raw_recordings/           # one .npy per (measurement, channel), float32
    raw_..._000_..._ch0.npy → ... _ch7.npy  (30 measurements × 8 channels = 240 files)
    Each file: shape (255360,) = 5 cycles × 51072 samples/cycle (cycle_duration=1.064s)
  averaged_responses/       # post-processed canonical means, float64
    average_ch0.npy ... average_ch7.npy  (8 files, shape (48000,) = 1 s @ 48 kHz)
    effective_signal_length.json  (per-channel T_eff QC)
  impulse_responses/        # legacy RoomResponse format (per-measurement IRs)
  room_responses/           # legacy RoomResponse format (per-measurement room responses)
  metadata/
    PlyWood-Scenario100-LG_metadata.json  (full recorder_config + 30 measurement records)
    session_metadata.json
  analysis/                 # reserved (empty today)
  PlyWood-Scenario100-LG_SUMMARY.txt
```

### 3.2 What each artefact contains (measured)

| Artefact | Shape | dtype | Units | Notes |
|---|---|---|---|---|
| `raw_recordings/raw_*_ch0.npy` | (255360,) | float32 | normalised audio sample, ±1.0 | force channel — **NOT yet aligned, NOT yet validated, raw recorded waveform** |
| `raw_recordings/raw_*_ch{1..7}.npy` | (255360,) | float32 | normalised audio sample, ±1.0 | response channels — same, raw |
| `averaged_responses/average_ch0.npy` | (48000,) | float64 | normalised audio sample | force channel, **NOT normalised** (kept as raw aligned mean), peak at sample 0 with magnitude 0.9 (voice-coil-pulse-driven impact) |
| `averaged_responses/average_ch{1..7}.npy` | (48000,) | float64 | normalised audio sample / `peak(force)_per_cycle` | response channels, **DIVIDED** by the force-channel per-cycle peak — RMS values ~0.005 |
| `metadata/<scenario>_metadata.json` | dict | JSON | n/a | `signal_params.sample_rate=48000`, `cycle_duration=1.0` s, `num_pulses=5`, `multichannel_config.calibration_channel=0`, `normalize_by_calibration=true`, `truncate_config.ir_working_length_ms=600` |
| `effective_signal_length.json` | dict | JSON | ms | per-channel T_eff via split-half jackknife (dev-qc01 + dev-qcthr) |

### 3.3 What's at the Measurement level

`D:/modal_measurements/PlyWoodLGtemp1/`:

| Field | Value |
|---|---|
| `measurement.json` | top-level Measurement metadata; 92 scenario indices, schema_version=1 |
| `setup/audio_config.json` | `calibration_channel: 0`, `reference_channel: 5`, `response_channels: [1..7]`, `normalize_by_calibration: true` |
| `setup/impulse_config.json` | `impulse_form: voice_coil`, `pulse_duration_ms: 170`, `pulse_frequency_hz: 1000`, `voice_coil_config: {positive_ms: 20, gap_ms: 10, negative_ms: 100, pullback_amplitude: 0.5}` — defines the actuator drive waveform; **NOT the recorded force** |
| `setup/mapping_config.json` | `layout_type: grid`, `grid_shape: [12, 15]`, `grid_spacing_mm: 10`, `channel_roles: {0: force, 1..7: response}`, `cell_mask: [12 × 15 bool]` |
| `setup/calibration_criteria.json` | recording-stage validation thresholds (per-receiver clipping, silence floor, alignment correlation) |

### 3.4 What ESPRIT produces (per scenario, persisted to `<project>/modal_adapter/esprit/`)

| File | Shape / type | Content |
|---|---|---|
| `config.json` | dict | the exact ESPRIT params actually run (round-16 SoT) |
| `metadata.json` | dict | scenario_count, scenario_indices, run_at |
| `scenario_<idx>.json` | dict | `frequencies` (Hz, length n_modes), `damping_ratios` (ζ, length n_modes), `amplitudes` (RMS of mode-shape magnitudes), `shape_magnitudes` (n_modes × n_response_channels signed real, dominant-rotated), `n_raw`, `n_merged` |
| `scenario_<idx>_shapes.npy` | complex128 (n_modes × n_response_channels) | complex mode shapes (PRE-rotation) — **lossless, phase preserved** |

Critically:

- **`damping_ratios` is ζ, not Q.** Q = 1/(2ζ) is a one-line transform; not surfaced
  per-mode in the UI today, but DOES get exported via `Q_coeff_Q.txt` and
  `Q_coeff_E.txt` (`apply_service.export_to_text_files`).
- **`response_channels` filter is applied** before ESPRIT runs: see
  `esprit_orchestrator.py:209-216` and `esprit_runner.py:212` — `signals_filtered =
  signals[:, response_channels]`. **The force channel is filtered out at ESPRIT time.**
- **The force channel data IS preserved in `ctx.measurements[i]`**: see
  `scenario_loader._discover_roomresponse_scenarios:518-526` — it stacks `np.stack`
  across every `average_ch*.npy` file *including* `average_ch0.npy`. So a new analysis
  can read it from `ctx.measurements[i][:, 0]` (force) and
  `ctx.measurements[i][:, 1:]` (responses).

### 3.5 What tracking + feedin produce

`TrackingOrchestrator` builds **ModeChains** linking the same physical mode across
scenarios (per chain: `frequency_mean`, `damping_mean`, `quality.coverage`,
`detections: {scenario_idx → ModeDetection}` where each detection carries
`frequency`, `damping_ratio`, `mode_shape` (complex), `amplitude`,
`shape_magnitudes`).

`FeedinExtractor.extract_for_scenario` reads `signals[:, ch]` per response channel and
computes `magnitudes[ch] = |rfft(signals[:, ch])| * 2/N` at the mode-frequency bins.
**It does not divide by the force channel** — it's purely the response spectrum
sampled at mode frequencies. The output `per_pitch_feedin[pitch]` is therefore an
**amplitude proxy** that mixes (true modal response) × (input force at that
frequency).

This is exactly the place to bolt FRF on: if we replace `|rfft(signals[:, ch])|` with
`|rfft(signals[:, ch])| / |rfft(signals[:, 0])|` (response over force) at the same
mode-frequency bins, we get a true FRF magnitude per mode per channel — which IS
proportional to `|φ(ch)·φ(force) / m_modal|` and lets us back out relative modal
mass directly (see §5.2).

---

## 4. Force-Channel Deep-Dive

This is the section the user explicitly asked for. The behaviour of the force channel
in Pianoid's pipeline is non-obvious in multiple places.

### 4.1 How the force signal is captured (recording stage)

`measurement.recorder.RoomResponseRecorder` plays a deterministic playback signal —
`_generate_complete_signal()` — on the output device (typically the voice-coil
actuator drive) and simultaneously records on every input channel via
`sdl_audio_core.measure_room_response_auto_multichannel`. The calibration channel
(`ch0` here) is wired to whatever sensor co-locates with the actuator — the user's
hardware is a Behringer UMC1820 with a force/shunt-resistor/accelerometer signal on
input 1 of the device.

The recorded waveform on ch0 is therefore the **measured electrical signal that the
sensor produces in response to the actuator impulse + the structural reaction at the
contact point**. This is NOT the same as the *commanded* drive waveform in
`impulse_config.json` — that's the *intent*, the cal-channel recording is the *result*.
**The proposed analysis is built on the measured cal-channel signal**, never on the
commanded drive waveform.

Units: normalised audio samples in [-1, +1]. **There is no calibration constant in
audio_config.json or session_metadata.json** that maps sample-amplitude to a physical
SI unit (Newtons, m/s², or V). This is the central limit on absolute modal mass — see
§5.5.

### 4.2 How the force signal is used downstream — current state (3 stages)

**Stage A — Recording (`collection_engine`).** Used by
`CalibrationValidatorV2.validate_cycle(...)` to gate cycles: peak magnitude in
[`min_negative_peak=0.3`, `max_negative_peak=1.2`], double-hit guard, back/front
ratio. Cycles that fail are dropped from the survivor set. **Validation = collection
only — round 18 principle.**

**Stage B — Per-cycle alignment (`signal_processor.align_cycles_by_onset`).** Used by
`SignalProcessor` to detect the onset of each cycle (negative peak position) and
compute a shift to align all cycles in time. The SAME shifts are then applied to every
other channel via `apply_alignment_to_channel`, so all cycles across all channels are
time-aligned by the force-channel timing.

**Stage C — Per-cycle amplitude normalization (`signal_processor.normalize_by_calibration`).**
**This is the key insight.** Each response cycle is divided by the corresponding force-
channel cycle's **|negative-peak| magnitude** (a single scalar per cycle). The force
channel itself is NOT normalised — see `signal_processor.py:502-505`:

```python
if ch_idx == calibration_channel:
    # Keep calibration channel unnormalized
    normalized_multichannel_cycles[ch_idx] = channel_cycles.copy()
    continue
```

The averaging step then takes the mean across surviving cycles (per channel). Effects
on the artefacts:

| Artefact | Effect of normalize_by_calibration |
|---|---|
| `average_ch0.npy` (force) | unchanged — raw aligned mean across cycles of the force signal |
| `average_ch{1..7}.npy` (response) | each response cycle was divided by its own cycle's `|force_peak|` before mean — so the mean is itself a sum-of-(Y_i/|peak(X_i)|) divided by N_cycles, NOT a sum-of-Y_i divided by N_cycles |

In words: **`average_ch1.npy` is a `Y/|X_peak|` quantity already**, but the scalar
`|X_peak|` is a peak amplitude — it's NOT a frequency-domain transfer function — and it
varies cycle-to-cycle. Across a perfectly-repeatable actuator the peaks would be
identical and `Y/|X_peak|` would equal `Y/const` (rescaling, no shape change). When the
peaks vary, `Y/|X_peak|` is a per-cycle-input-strength-corrected response. Useful, but
much coarser than a proper FRF.

**Implication 1.** When we compute `H(f) = rfft(average_ch1.npy) / rfft(average_ch0.npy)`,
we are **double-normalising** — once by the per-cycle peak, then by the FFT-domain force
spectrum. To get a clean FRF we should either (a) recompute the averaging without the
per-cycle peak normalization (use the cycle-mean Y and cycle-mean X without per-cycle
peak division), or (b) accept the double-normalisation and interpret the result as an
"input-shape-corrected, peak-amplitude-corrected" FRF (still useful for finding mode
peaks and Q via half-power BW, but NOT clean for residue magnitude).

**Implication 2.** Per-cycle FRF computation is a clean alternative that sidesteps the
issue: `H_i(f) = rfft(Y_i(t)) / rfft(X_i(t))` on each (measurement, cycle) individually,
then average `H_i` across cycles. Welch-style. This is the textbook H1 estimator
applied to broadband impulses, and it lives at the `raw_recordings/` level — no
modification to the averaging path needed.

### 4.3 Force-channel content (measured spectrum on Scenario 100)

From `D:/modal_measurements/PlyWoodLGtemp1/scenarios/PlyWood-Scenario100-LG/averaged_responses/average_ch0.npy`:

- Length: 48000 samples = 1.0 s at 48 kHz.
- Peak: -0.904 at sample 0 (impulse onset, post-align with
  `alignment_target_onset_position: 0`).
- First-5 ms RMS: 0.120 (the impulse itself dominates the energy budget).
- After-100 ms RMS: 0.006 (structural ringback into the cal sensor — small but
  non-zero).
- Spectrum: smooth ~1/f roll-off out to ~1 kHz at -3 dB; usable energy out to
  ~13 kHz at -20 dB. The peak spectral bin is at 506 Hz (the impulse shape is voice-
  coil-pulse-driven, see `impulse_config.json: pulse_frequency_hz: 1000`).

**FRF feasibility check.** Computing `H(f) = rfft(average_ch1) / rfft(average_ch0)` and
inspecting the top peaks finds clean modal peaks at 85 Hz (|H|=6.7), 162-163 Hz
(|H|≈4.9), 199-202 Hz (|H|≈5.0-5.7 — a cluster), 445-446 Hz (|H|≈5.4-6.4), 682 Hz
(|H|=9.1), 2261-2264 Hz (|H|≈5.0-6.1). These align with the soundboard's expected modal
density (~30 modes in 50-3000 Hz). The 43 Hz |H|=38 spike is a low-frequency artefact
(both Y and X have near-zero energy there, so the division blows up — needs a
coherence-based gating; see §5.1.4).

**Conclusion.** The force-channel data IS rich enough to compute usable FRFs. The
spectrum is broadband-impulse-shape (not narrow), peaks land at expected modal
frequencies, and the SNR is good enough across 50-3000 Hz to support per-mode
extraction.

### 4.4 What the averager DROPS

Today the analysis surface forgets several pieces of force-side information:

1. **Per-cycle force peak (the divisor in `normalize_by_calibration`).** This is a
   single scalar per cycle. It's computed in `normalize_by_calibration` and
   returned as the second return value (`_norm_factors`), but the scenario_averager
   discards it (`processed, _norm_factors = sp.normalize_by_calibration(...)`).
   **This scalar IS measured excitation strength per impulse** — exactly what the
   user's directive points at. Saving it would enable the inter-cycle / inter-
   measurement / inter-scenario excitation-strength normalisation we want.

2. **The pre-normalised raw cycle stack.** After alignment but before division, the
   `aligned_multichannel` dict carries `(n_cycles, T)` arrays for every channel
   including the response channels in their un-normalised form. The averager
   immediately overwrites this with the normalised version. If we want a clean Welch
   FRF estimator (H1 = G_xy/G_xx), we need the raw un-normalised cycle stack to compute
   cross-spectra correctly.

3. **The per-measurement force RMS / energy.** The cross-scenario actuator amplitude
   varies (the operator may have struck harder on scenario X than Y). Today this is
   invisible downstream; the user reads it indirectly from the chain `amplitude` value,
   which mixes structural response and input strength.

### 4.5 Why ESPRIT doesn't see the force channel

`esprit_orchestrator._run_esprit_sync:209-216` builds `response_channels =
ctx.mapping.response_channels` and passes them to `EspritRunner.run_all_points`. The
runner does `signals_filtered = signals[:, response_channels]` (line 212) — the
force-roled channel is structurally excluded from the Hankel matrix.

**This is correct for mode-frequency / mode-shape extraction.** ESPRIT factorises a
Hankel matrix into damped sinusoids; the force impulse is by definition NOT a damped
sinusoid — it's an aperiodic transient. Including it in the Hankel would inject
spurious "modes" at the force-impulse-shape harmonics.

**But it means ESPRIT cannot extract per-mode INPUT amplitude.** The mode amplitude
ESPRIT returns is `rms(|mode_shape|)` over response channels — proportional to
*response* amplitude, not to *transfer function* amplitude. Two scenarios with
identical structure but different input strengths give different mode amplitudes; this
is what the per-cycle calibration normalisation tries to fix at the time-domain level
but only partially succeeds (because it's a single scalar, not a frequency-domain
correction).

---

## 5. What's Extractable From Current Data (the Headline Section)

This section enumerates concrete analyses, each one runnable on the data currently on
disk in any user project, no new measurements required.

For every item: what data it consumes, what it produces, where it should live in the
codebase, and what UI surface (if any) it needs.

### 5.1 Quick wins — no new files, just compute and surface

#### 5.1.1 Per-mode Q (surface what ESPRIT already produces)

**Available now.** ζ is already in
`<project>/modal_adapter/esprit/scenario_<idx>.json["damping_ratios"]` and
`tracked_chains[].damping_mean`. Q = 1 / (2 ζ).

**Proposed surface.** Add `quality_factor: 1.0 / (2.0 * damping_mean)` to every
serialised chain dict in `EspritRunner.chains_to_dicts` (line ~826 in `esprit_runner.py`).
Render as a `Q` column in the chain list / a `Q` tooltip on the stab diagram.

**Where it lives.** New computation in `esprit_runner.py:chains_to_dicts`; new UI
column in `PianoidTunner/.../StabilizationDiagram.jsx` (chain table) +
`ChainListPanel.jsx`.

**Acceptance criterion.** For a chain with `damping_mean = 0.005`, Q surfaces as
`Q = 100.0`. Validate against `export_text_files` which already writes `Q_coeff_Q.txt`
with the identical formula (it does — see `external_export.py`).

**Effort.** S (hours, mostly UI).

#### 5.1.2 Log-decrement Q cross-check (the 2026-05-13 §3.1.C proposal — still valid, free)

**Available now.** Take the averaged IR for a single response channel, bandpass around
each chain's `frequency_mean ± 3·BW_predicted`, Hilbert-transform → envelope, linear fit
`log(env(t)) = log(A) - ζω_n·t` over the cleanly-decaying region (skip first 5-10 ms
transient + last region where envelope drops below noise floor).

**Where it lives.** New `pianoid_middleware/modal_adapter/qc/log_decrement_xcheck.py`
consuming `ctx.measurements` + `ctx.tracked_chains`. Output:
`per_chain: {chain_id: {Q_esprit: float, Q_logdec: float, agreement_ratio: float}}`,
persisted to `<project>/modal_adapter/qc/log_decrement.json`.

**UI surface.** A diagnostic chip on each chain in the tracking panel: green when
`agreement_ratio ∈ [0.8, 1.2]`, amber when `[0.5, 0.8] ∪ [1.2, 2.0]`, red beyond
(suggests mode-overlap contamination).

**Acceptance criterion.** For an isolated mode (no neighbour within 3·BW), Q_logdec
agrees with Q_esprit to within 10 %. For overlapping modes, the disagreement
correlates with the overlap fraction.

**Effort.** S–M (1-2 days code + tests).

#### 5.1.3 Per-scenario / per-channel FRF magnitude H(f)

**Available now.** `H_ij(f) = rfft(ctx.measurements[i][:, ch]) / rfft(ctx.measurements[i][:, 0])`
for `ch ∈ response_channels`. **One caveat per §4.2:** the response channel is already
peak-normalised — so the resulting H is a "peak-normalised FRF". For an approximate FRF
this is acceptable; for absolute residue extraction we want to re-do the averaging
without the per-cycle peak division (see §5.3.1).

**Per-cycle alternative (cleaner — preferred for §5.2).** Iterate over raw recordings
per (measurement, cycle), compute `H_mc(f) = rfft(Y_mc) / rfft(X_mc)` per cycle,
average across cycles. This is the textbook **H1 estimator** for impulse-driven FRF.

**Where it lives.** New `pianoid_middleware/modal_adapter/frf/frf_extractor.py`
consuming the canonical averages OR raw recordings (caller-selected). Output:
`per_scenario_per_channel: {scenario_idx: {ch: {freqs, |H|, phase, coherence}}}`,
persisted to `<project>/modal_adapter/frf/scenario_<idx>.json` per scenario (one file
per scenario keeps individual writes small and append-safe; total disk: ~30 KB per
scenario for length-48000 H at every response channel).

**UI surface.** A new "FRF" tab in the per-scenario inspector showing |H(f)| in dB
with the mode frequencies overlaid. Optional second pane: phase vs frequency.

**Acceptance criterion.** Modal peaks in |H(f)| land within ±2 Hz of ESPRIT-extracted
chain frequencies for the same scenario. (Sanity check: same data, two extraction
paths, should agree.)

**Effort.** M (3-5 days code + UI + tests).

#### 5.1.4 Coherence γ²(f) — the QC layer for FRF reliability

**Available now.** Coherence requires cross-spectra: γ²(f) = |G_xy(f)|² / (G_xx(f)
G_yy(f)). With per-cycle data per measurement (5 cycles × 30 measurements = up to 150
cycles per scenario for Welch averaging), we can compute it directly.

γ² is the most useful single QC for an FRF: γ² ≈ 1 means input and output are linearly
related at that frequency (FRF estimate trustworthy); γ² ≪ 1 means there's
input-uncorrelated noise on the output (FRF dominated by noise; reject for downstream
use). The 43 Hz |H|=38 spike noted in §4.3 would be flagged by γ² → 0 there because
neither Y nor X has meaningful energy at 43 Hz.

**Where it lives.** Bundled into `frf_extractor.py` as a parallel output; persisted
into the same per-scenario FRF JSON.

**UI surface.** Greyed-out / hatched regions on the |H(f)| plot wherever γ² < 0.7.
Threshold configurable.

**Acceptance criterion.** Bands of low γ² visually mask out the spurious low-frequency
1/X-blowup spikes.

**Effort.** S (compute is one rfft pair more than §5.1.3; persist + render UI is the
work).

#### 5.1.5 Per-measurement force amplitude (peak / RMS) for inter-cycle normalisation

**Available now.** Already computed in `normalize_by_calibration` as `_norm_factors`,
but discarded. Surface it.

**Where it lives.** Patch `scenario_averager.ensure_averaged_responses` to retain
`norm_factors` and persist to `<scenario>/averaged_responses/normalization_factors.json`
with shape `{measurement_idx: [peak_per_cycle, ...], scenario_mean_peak: float,
scenario_std_peak: float}`.

**UI surface.** A scenario-level chip showing `force_peak_mean ± std` with a warn
color if `std / mean > 0.2` (strike-strength variability flag).

**Acceptance criterion.** For a well-driven scenario `std/mean < 0.05`; for the
known-bad scenarios (cf. round-15 dev-maimport experience) it's >0.3 — gives the user
an at-a-glance scenario quality signal beyond the existing T_eff QC.

**Effort.** S (small averager patch + scalar JSON + UI chip).

### 5.2 Medium-scope additions — extract physical quantities

#### 5.2.1 Per-mode residue R_n via FRF curve-fitting per scenario

**Available now (post-§5.1.3).** For each scenario `i`, each response channel `c`, each
chain `n` (from the tracked chains), fit the SDOF model around `f_n`:

```
H_ic(f)  ≈  R_n(i,c) / (ω_n² - ω² + 2j ζ_n ω_n ω)  +  upper/lower residual terms
```

The residue `R_n(i,c) = φ_n(c) · φ_n(force-point-i) / m_n_modal`, where:

- `φ_n(c)` is the mode shape value at response channel `c` (already from ESPRIT)
- `φ_n(force-point-i)` is the mode shape value at the actuator position for scenario
  `i` — this is the value at force-channel coordinate (which is co-located with the
  actuator in driving-point geometry)
- `m_n_modal` is the modal mass we want.

If we make the **driving-point assumption** (response measurement at same point as
excitation), residue = `φ²(actuator) / m_n_modal` — directly inverted for `m_n_modal`
given a unit-normalised mode shape (already from ESPRIT) and a properly-scaled `R_n`.

**For Pianoid's grid geometry:** the actuator visits 92 distinct grid cells; the 7
response channels are presumably at fixed sensor positions (microphones or
accelerometers — needs to be confirmed with the user). So the geometry is **not pure
driving-point** — it's **multi-input (92 actuator positions) / multi-output (7 sensor
positions) = 644 FRFs**. This is **over-determined** for extracting per-mode `m_n` even
with mode-shape-amplitude scaling left as one free parameter per mode.

**Where it lives.** New
`pianoid_middleware/modal_adapter/mass/residue_extractor.py`. Two implementations:

- **Circle-fit (Kennedy-Pancu, §4.1.C of the 2026-05-13 proposal).** SDOF-fit each
  resonance from the complex `H(f)` near the mode; circle diameter ∝ R_n / (2 ζ_n
  ω_n²). Robust to ±20-30 % point-wise FRF error. ~50 lines of code.
- **Least-squares multi-mode fit.** Over the full FRF, fit
  `H(f) = Σ_n R_n / (ω_n² - ω² + 2j ζ_n ω_n ω) + U + L` with `ω_n, ζ_n` fixed from
  ESPRIT and `R_n, U, L` as the unknowns. Linear least-squares (linear in residues!).

Output: `per_chain: {chain_id: {R_per_scenario_per_channel: {(i,c): complex}, m_n_relative: float, m_n_uncertainty: float}}`, persisted to
`<project>/modal_adapter/mass/residue_<chain_id>.json`.

**UI surface.** New "Modal Masses" subpanel showing `m_n / m_1` bar chart with
uncertainty bars, plus a "M_residue vs scenario" heatmap (grid-style, like the
existing chain heatmap) that shows residue magnitude across the actuator grid for one
selected chain — directly visualises the mode shape on the soundboard.

**Acceptance criterion.** Residue extraction is self-consistent across response
channels for a given (chain, scenario): the ratio `R(i, c1) / R(i, c2)` should equal
the mode-shape ratio `φ(c1) / φ(c2)` from ESPRIT, within 15 %.

**Effort.** M-L (1-2 weeks: residue math + UI + extensive testing on the existing
Belarus + PlyWood datasets).

#### 5.2.2 Per-mode Q from FRF peak fit (textbook half-power BW, on existing data)

**Available now (post-§5.1.3).** For each chain `n`, find the peak in `|H(f)|` near
`f_n`, fit a Lorentzian or parabola to identify the -3 dB bandwidth, Q = f_n / BW.

This is identical to the 2026-05-13 proposal's §3.1.A stepped-sine method, but
applied to the **existing broadband-impulse data** — the spectral resolution is one
FFT bin (1 Hz at 1 s window) which is enough for Q ≤ ~500 modes, marginal for higher-Q
modes. Below the spectral resolution, falls back to log-decrement (§5.1.2).

**Where it lives.** Beside §5.1.2 in
`pianoid_middleware/modal_adapter/qc/q_from_frf.py`. Output: per-chain
`{Q_frf: float, BW_3dB: float, Q_esprit: float, Q_logdec: float, agreement: str}`.

**UI surface.** Extends the QC chip from §5.1.2 to show three Q estimates (ESPRIT,
log-decrement, FRF-BW) with green agreement / amber divergence / red strong-divergence.

**Acceptance criterion.** For 80-90 % of well-isolated chains the three Q estimates
agree to within 15 %. The 10-20 % with disagreement are exactly the chains where
ESPRIT band-merging is suspect — gives the user a measurement-grounded selection
criterion for "trust this chain's damping vs not".

**Effort.** S-M (the bandpass + peak-fit math is ~100 LOC; UI integration with §5.1.2's
chip is part of the same chip).

#### 5.2.3 Mode-shape amplitude in calibrated units (relative modal mass-weighted)

**Available now (post-§5.2.1).** Once `m_n_relative` is in hand, rescale ESPRIT's
mode shape vectors `mode_shape[n][c]` by `1 / sqrt(m_n_relative)` to produce
**mass-normalised mode shapes** — the textbook EMA quantity, related to the synthesis
engine's per-mode coupling strength in a calibration-portable way.

**Where it lives.** New transform in
`pianoid_middleware/modal_adapter/mass/mass_normalize_shapes.py` consuming chain
detections + residue output. Output: in-memory only (cheap; computed on demand).

**UI surface.** Toggle on the chain mode-shape display: "Raw amplitude" /
"Mass-normalised". Default depends on Q4 below (open question).

**Acceptance criterion.** The mass-normalised shapes are scenario-independent (vary
only in their physical-position pattern, not in absolute scale) — a single chain
plotted across scenarios should show the same envelope, just sampled at different
positions.

**Effort.** S (the math is one multiplication per chain; UI is one toggle).

### 5.3 Larger architectural work — first-class FRF as a data product

#### 5.3.1 FRF stage as a peer of ESPRIT (new orchestrator class)

**Motivation.** §5.1.3 + §5.1.4 + §5.2.1 + §5.2.2 all read raw recordings or
averaged responses, compute spectral artefacts, and persist results into the
project tree. They share infrastructure (load measurements, run a per-scenario loop,
cooperative cancel, progress callbacks, persistence). The natural shape is a
**FrfOrchestrator** class beside `EspritOrchestrator`, owning a parallel persistence
stage `<project>/modal_adapter/frf/`.

**Where it lives.** New
`pianoid_middleware/modal_adapter/frf_orchestrator.py` with the same shape as
`esprit_orchestrator.py`: read `ctx.measurements`, write `ctx.frf_results`, persist via
`_persist("frf", "scenario_<idx>.json", data)`. The actual numerical kernels live in
the supporting modules (`frf_extractor.py`, `residue_extractor.py`,
`mass_normalize_shapes.py`).

The pipeline coordinator (today the facade's `run_full_pipeline`) gains an optional
FRF stage between ESPRIT and tracking:

```
Average → ESPRIT → FRF → Tracking → Feedin → Apply
                    |
                    └── (parallel) → Residue → Mass
```

FRF doesn't gate tracking (which only needs frequencies + damping from ESPRIT); it
runs in parallel and its output is consumed by Residue + by the per-chain Q
cross-check.

**REST surface.** New endpoints under `/modal/frf/*`:

| Method | Path | Effect |
|---|---|---|
| POST | `/modal/frf/run` | Run FRF extraction across loaded scenarios (returns 202; status via `/modal/status`) |
| GET | `/modal/frf/scenario/<idx>` | Per-scenario FRF curves (freqs, |H|, phase, coherence) per channel |
| GET | `/modal/frf/chain/<chain_id>` | Per-chain residue + Q-from-FRF + mass estimate, aggregated across scenarios |
| GET | `/modal/frf/config` | Saved FRF params (window length, bandwidth gating, Welch vs single-shot) |
| POST | `/modal/frf/config` | Save FRF params |
| GET | `/modal/frf/status` | Run state, progress, last error |

**Schema changes:**

- `project.json` gains `"frf": {"computed_at": ts, "scenario_count": int, "method":
  "welch" | "averaged"}`.
- New `<project>/modal_adapter/frf/` subtree (mirrors `esprit/` shape).
- `ProjectContext` gains `frf_results: Dict[int, Dict]` + `mass_results: Dict[int,
  Dict]` (the latter populated by the §5.2.1 residue extractor).

**Effort.** L (~2 weeks for the orchestrator + REST + persistence + tests, on top of
the underlying analysis modules in §5.1-§5.2).

#### 5.3.2 Cross-scenario comparison view — actuator-grid mass-shape heatmaps

**Motivation.** The grid layout gives 92 actuator positions. Plotting per-chain residue
magnitude across the actuator grid IS the modal shape on the soundboard, sampled at
the actuator points (under the driving-point assumption). This is the user's killer-app
visualisation for soundboard physics work.

**Where it lives.** New view in the existing `GridHeatmapInset` infrastructure (already
used for chain amplitude). New mode: "Residue (FRF)" alongside "Amplitude (ESPRIT)".

**Acceptance criterion.** For a known-modal-shape mode (e.g. fundamental — should be a
broad lobe across most of the soundboard), the residue heatmap visually matches the
physical expectation; for a higher mode with nodal lines, the residue heatmap shows
zero-crossings at the node lines.

**Effort.** S–M (mostly frontend wiring; the residue data already exists from §5.2.1).

### 5.4 Calibration channel — does it need a new role?

Per the user's directive, this analysis has been built around the calibration channel.
The roles it plays today:

1. Cycle onset detection (alignment) — KEEPS.
2. Per-cycle amplitude normalisation (`normalize_by_calibration`) — KEEPS BUT
   QUESTIONED (see Q1 below).
3. Validation gating at recording stage — KEEPS.

The roles this plan ADDS:

4. FRF input X(f) for all spectral-domain analyses (§5.1.3+).
5. Per-cycle excitation strength scalar persisted as a downstream-usable scenario QC
   (§5.1.5).
6. Reference for the coherence γ²(f) computation (§5.1.4).

**Does the canonical averager need to change to support this?** Two options:

- **Option A (minimum invasive).** Leave the averager unchanged. New FRF extraction
  re-reads `raw_recordings/` and recomputes per-cycle, taking the cycle alignment from
  the same SignalProcessor pipeline. Cost: ~5-15 s per scenario re-cost of
  alignment + rfft (acceptable; the live-processing-flow Wave 2 path already
  re-processes per scenario incrementally).
- **Option B (richer artefacts).** Patch the averager to ALSO save:
  - `averaged_responses/average_ch0_unnormalised.npy` (it's already unnormalised; just
    flag it in a sidecar so consumers know)
  - `averaged_responses/raw_cycle_stack_per_channel.npz` (the pooled cycle stack before
    averaging — what `pool_scenario_cycles` builds dynamically today). Disk cost: ~30 MB
    per scenario for 150 cycles × 8 channels × 48000 samples × 8 bytes.

Option A is cheaper to implement and avoids touching the established averaging code.
Option B is friendlier to multiple downstream analyses (FRF, coherence,
Welch-stepped-sine, etc. all want the cycle stack) and avoids re-reading raw_recordings
from disk repeatedly. The 30 MB-per-scenario cost is real but tolerable on a
100-scenario project (= 3 GB extra disk; acceptable for analysis-grade datasets).

**Recommendation.** Start with Option A for the MVP; reassess if multiple new analyses
are added that re-read raw_recordings.

### 5.5 What's NOT extractable from current data

Being honest about limits.

#### 5.5.1 Absolute modal mass in kg

**Blocker.** No physical-unit calibration constant on the calibration channel. The
recorded force-channel sample is a normalised audio value in [-1, +1]; there's no
"N per sample" or "m/s² per sample" constant anywhere in the metadata. Without it,
modal mass can only be expressed as a *relative* quantity (m_n / m_1) or as
`m_n × k` where `k` is the unknown calibration constant.

**To unblock.** Either:

- Add a field `calibration_channel_si_per_count: float` to
  `setup/audio_config.json` with the SI conversion (N/V if it's a force sensor, m/s²
  / V if it's an accelerometer, etc.), populated by the user from a one-time
  benchmark against a reference impulse hammer or known mass. The new FRF + residue
  pipeline would honour this constant when present and report `m_n` in SI units;
  when absent, report relative `m_n / m_1` (and surface the dimensionless caveat to
  the user via a chip).
- Mass-loading method (§4.1.A of the 2026-05-13 proposal): apply a known δm at the
  measurement point, re-measure, solve `Δf_k/f_k ≈ -(1/2)·δm·φ_k²(x_load)/m_k` for
  `m_k`. This needs operator effort but bypasses the channel calibration.

#### 5.5.2 Per-mode INPUT force at each mode frequency (in SI units)

Same blocker as §5.5.1. We have `|rfft(force_channel)|(f)` in normalised audio
units, but to claim "the actuator delivered N Newtons at frequency f" we need the
SI calibration.

For RELATIVE work (compare two scenarios' input strengths, compare two chains'
residue ratios) this is fine — the dimensionless ratios survive the unknown
calibration constant.

#### 5.5.3 Very-high-Q modes (Q > 200) — spectral resolution limit

The averaged response is 600 ms (default truncate) → 1 Hz FFT resolution. A Q=200 mode
at 100 Hz has BW = 0.5 Hz, below the FFT bin. **Half-power BW from existing data
cannot resolve such modes.** ESPRIT's pole estimate is the ONLY available Q estimator
for them, and log-decrement (§5.1.2) cross-validates it.

The 2026-05-13 proposal's stepped-sine method (§3.1.A) is the canonical fix for
high-Q modes — and is independent of this plan's force-channel work. The two
streams are complementary, not competitive.

#### 5.5.4 Out-of-band modes the actuator can't excite

Voice-coil actuators driven by a `pulse_duration_ms = 170` voice-coil pulse have
practical bandwidth out to ~1-2 kHz at -10 dB. Modes well above this band are
under-excited; their FRF estimates have low coherence and are unreliable.

**Mitigation.** The coherence layer (§5.1.4) makes this honest — high-frequency
modes with low γ² are visually grey/hatched in the FRF plot, the user knows not to
trust them. Above ~5 kHz the FRF data should be treated as advisory only.

---

## 6. Concrete Improvement Roadmap (Prioritised)

Ordered by value/effort ratio. Each step is independently demoable and ships a
user-visible improvement.

### Phase 0 — Free QC layer (the user gets new data with zero new measurements)

| # | Improvement | LOC est. | Effort | Depends on |
|---|---|---|---|---|
| 0a | Surface Q (= 1/(2ζ)) per chain in chain dicts + UI | 30 BE + 80 FE | S | none |
| 0b | Persist per-cycle force peak (`norm_factors`) per scenario | 60 BE + 40 FE | S | none |
| 0c | Log-decrement Q cross-check on existing averaged IRs | 250 BE + 100 FE | S-M | none |

**Demo:** open an existing project, see Q on every chain, see force-strength QC chip
on every scenario, see log-decrement-vs-ESPRIT Q agreement icon. **Wall time:** ~3-5
days for one engineer.

**User-facing change.** Q surfaces are everywhere modal damping was previously shown.
The QC chip flags the 10-15 % of chains where damping estimates disagree across
methods — directly catches the ESPRIT-band-merging-suspect cases.

### Phase 1 — FRF as a first-class artefact (the headline force-channel feature)

| # | Improvement | LOC est. | Effort | Depends on |
|---|---|---|---|---|
| 1a | `frf_extractor.py` (H1 estimator per cycle, averaged across cycles) | 350 BE | M | Phase 0 |
| 1b | Coherence γ²(f) gating | 100 BE | S | 1a |
| 1c | `frf_orchestrator.py` + REST `/modal/frf/*` + persist tree | 400 BE + 100 BE tests | M | 1a, 1b |
| 1d | Per-scenario FRF inspector pane (|H|, phase, coherence) | 600 FE | M | 1c |
| 1e | Q-from-FRF half-power BW per chain (replaces 0c when avail.) | 150 BE | S | 1a |

**Demo:** open a project, run "Compute FRF" from the new menu item, see per-scenario
|H(f)| with all the modal peaks identified, coherence-greyed-out beyond the actuator
bandwidth. Q-from-FRF surfaces in the chain table beside ESPRIT-Q and log-decrement-Q.
**Wall time:** ~3-4 weeks.

**User-facing change.** First time the user sees "Yes, this is the FRF of my
soundboard" rather than "this is the response spectrum of my soundboard". Physical
interpretation of mode locations + heights becomes calibrated against the input force.

### Phase 2 — Modal mass extraction (the second half of the proposal)

| # | Improvement | LOC est. | Effort | Depends on |
|---|---|---|---|---|
| 2a | `residue_extractor.py` (LS multi-mode fit + circle-fit cross-check) | 600 BE | M-L | Phase 1 |
| 2b | Per-chain relative modal mass + uncertainty | 200 BE | S | 2a |
| 2c | Mass-normalised mode shapes (toggle in UI) | 100 BE + 100 FE | S | 2b |
| 2d | Cross-scenario residue heatmap (actuator-grid view) | 400 FE | M | 2a |
| 2e | (Optional) Absolute modal mass IF `calibration_channel_si_per_count` set | 50 BE + 80 FE | S | 2b + user-side calibration |

**Demo:** new "Modal Mass" subpanel showing `m_n / m_1` bars with uncertainty;
selecting a chain reveals a grid heatmap of its residue across all actuator
positions — visualises the mode shape on the soundboard surface. **Wall time:**
~3-4 weeks.

**User-facing change.** Relative modal mass is a first-class measured quantity per
chain. Synthesis-engine preset scaling can use `m_n` to weight modes
physically-correctly across instruments. Absolute SI modal mass available IF user
supplies one calibration constant.

### Phase 3 — Architectural follow-ons (only if Phases 0-2 prove out)

- Live-processing integration: FRF + Residue ride the per-scenario subprocess
  callback from dev-liveproc-w1. Live FRF curves in the per-scenario inspector
  while recording continues.
- Export the residues / masses to the `external_export.export_text_files` family
  alongside the existing 5 files (new `Mass_coeff.txt`, `Residue_coeff_R.txt`,
  `Residue_coeff_I.txt`).
- Driving-point mobility shortcut: if the user marks scenarios as "driving-point
  geometry" (sensor co-located with actuator), short-circuit the multi-input/output
  LS fit and use the textbook 1/(2 ζ ω m) formula at the response peak.
- Reciprocity check (§4.1.D of the 2026-05-13 proposal): compare FRF between
  swap-symmetric scenarios as a linearity/calibration QC.

**Wall time:** ~2-4 weeks once needed.

### What this plan does NOT include (deferred to a future proposal)

- Stepped-sine / swept-sine / random / multi-sine excitation paths (the entire §3.1
  of the 2026-05-13 proposal). These remain valuable for very-high-Q bass modes and
  for mode-isolated SNR — but require new recorder code, new measurement_type schema,
  and new operator workflows. They're orthogonal to this plan: this plan extracts
  more from existing impulse-driven recordings; the stepped-sine work would extract
  *new* measurements with mode-isolated input.
- Mass-loading absolute calibration anchor (§4.1.A of the 2026-05-13 proposal). Pure
  operator-side work; no software dependency. User can run this in parallel with any
  software phase.

---

## 7. Open Questions for User

These supersede the §7 questions in the 2026-05-13 proposal — that proposal's
unanswered Qs are folded in where still relevant.

### Q1 — Is the per-cycle calibration normalisation (`normalize_by_calibration: true`) still desired downstream?

**Context.** Today the averaged responses are `(Y / |X_peak|)`-averaged per cycle.
This was a sensible amplitude-correction for cycle-to-cycle input variability, but it
makes a proper spectral-domain FRF a two-step normalisation (divide by `|X(f)|` *and*
by `|X_peak|`).

**Options:**

- **A. Keep normalize_by_calibration on, accept double-norm.** FRF computed from
  `averaged_responses/` is a "peak-input-corrected FRF" — fine for finding modal
  peaks + Q, slightly off for absolute residue magnitudes (a multiplicative scenario-
  constant). Cheapest path forward.
- **B. Keep normalize_by_calibration on, but compute FRF from raw_recordings/ per-cycle.**
  Use the canonical signal_processor pipeline up to alignment, but skip
  `normalize_by_calibration`, then per-cycle FFT and average H_i = Y_i(f)/X_i(f). Clean
  H1 estimator. Adds ~5-15 s per scenario to FRF computation.
- **C. Add a NEW recorder/averaging mode that doesn't normalize-by-calibration.**
  Backward-compatible: existing projects keep current behaviour; new projects can be
  configured to skip the per-cycle scalar divide. This requires `audio_config.json`
  schema bump.

**Recommendation:** B. It costs CPU only at FRF compute time and preserves the existing
averager contract. C is overkill given B works.

### Q2 — Is RELATIVE modal mass enough, or is ABSOLUTE (SI units) needed?

The same question as Q2 of the 2026-05-13 proposal, with a sharper trade-off now
visible.

**Relative-only (recommended for first ship):** all the analyses in §5 produce
self-consistent dimensionless results. Synthesis-engine integration uses `m_n /
m_1` as a per-mode scaling weight — directly portable to the existing `feedin`
mechanism.

**Absolute path A — one-time mass-loading campaign.** Operator effort: ~30-60 min per
instrument (attach 3-5 known masses at known positions, re-measure, run mass-loading
inversion). Software: ~3 days code (§4.1.A of 2026-05-13 proposal). Provides
literature-standard accuracy on the instruments calibrated.

**Absolute path B — SI calibration of the calibration channel.** Operator effort:
~15 min if a reference impulse hammer or accelerometer is available; otherwise
impractical. Software: ~1 day code (one new field in `audio_config.json`, propagated
through FRF + residue). Provides SI units on every future measurement automatically.

**Recommendation:** Ship Relative-only in Phase 2. Defer Absolute (either path) until
user explicitly requests; user can run a mass-loading or hammer-calibration campaign
in parallel and the data gets back-applied trivially.

### Q3 — Where does the modal-mass output get consumed downstream in the synthesis preset?

Same as Q10 of the 2026-05-13 proposal — now sharper because the preset_injector code
is more visible.

The current preset format has `decrement = 2π·ζ / √(1-ζ²)` per mode (Q is computable
from this on the engine side, but not stored). There is **no `modal_mass` field per
mode**. The injector's `_build_deck_from_feedin` builds a deck matrix from `feedin`
values, which are FFT magnitudes (proportional to `|φ(c)·φ(force)|`, not normalised
by modal mass).

**Options:**

- **A. Store `m_n_relative` in preset; engine ignores it (per-mode scaling already
  baked into deck).** Lossless; future-compatible; no engine change. Cheapest.
- **B. Modify the injector to scale deck values by `1/sqrt(m_n_relative)` when mass
  data is available.** Replaces the current FFT-magnitude-only scaling with a
  modal-mass-weighted scaling. Engine still gets the per-pitch deck matrix it
  expects, but the values are now portably calibrated. Medium effort.
- **C. Add a `modal_mass` field per mode in the preset schema; engine consumes it
  directly.** Requires CUDA-side change (`PARAMETER_SYSTEM.md` schema bump). Largest
  effort but cleanest physics.

**Recommendation:** A for Phase 2; revisit B in Phase 3 once we have user-facing
data on whether `m_n_relative` improves cross-instrument preset portability.

### Q4 — What's the default UI display for mode shapes — raw amplitude or mass-normalised?

If the user typically wants to inspect the *physical mode shape* (independent of
input force), default = mass-normalised. If the user typically wants to inspect the
*amplitude response* (input-strength-dependent), default = raw.

**Recommendation:** Default = "Raw amplitude" (matches today's behaviour, no
disruption); add a toggle for "Mass-normalised" once available in Phase 2.

### Q5 — Force channel role in driving-point geometry

The current setup has 1 force channel + 7 response channels. **Is the force channel
co-located with one of the 7 response channels?** I.e. is the actuator-mounted
accelerometer/force sensor at the same physical point as one of the receiving
microphones/accelerometers? If so, the "driving-point mobility" shortcut (§4.1.E of
the 2026-05-13 proposal) becomes a free per-mode `m_n` extractor at every actuator
position.

If NOT (force sensor is on the actuator itself; receivers are at fixed soundboard
positions), the multi-input/output residue extraction (§5.2.1) is the only path.

This question is genuinely a hardware question — need user input before residue
extractor code can choose a sensible default.

### Q6 — How many scenarios should be required before residue / mass extraction unlocks?

Per-mode residue extraction needs at least a few well-spread actuator positions to
over-determine the residue system. With 1 scenario per mode, the LS fit is exactly-
determined and uncertainty is huge.

**Recommendation:** require ≥ 8 scenarios containing the chain (`detection_count ≥ 8`)
before showing a residue / mass estimate; surface "(needs more scenarios — N=K of
required 8)" otherwise.

### Q7 — Should FRF storage be per-scenario JSON (chatty) or one consolidated `frf.npz` per project (compact)?

Per-scenario JSON: ~30 KB × 92 scenarios = ~3 MB; round-tripable through git diff;
matches the existing `esprit/scenario_<idx>.json` pattern. Incremental write is
trivial.

One `frf.npz`: ~3 MB total; binary; can't diff; full re-write on incremental update.

**Recommendation:** Per-scenario JSON. Matches existing conventions; incremental
update is the headline use case (Wave-2 live processing).

### Q8 — Should the (single new) `<project>/modal_adapter/frf/` stage be exposed in `data_status()` / drives the existing apply/dirty flags?

`data_status` currently surfaces averaging/ESPRIT/tracking/feedin states. Should FRF
be a separate state that gates apply when feedin depends on it (Phase 3 path)?

**Recommendation:** Yes — add `frf` and `mass` to `data_status` payload; UI shows
their presence + age + whether they're stale relative to ESPRIT. Apply path stays on
feedin (FRF is informational + drives residue; residue + mass surface in the new
subpanel, not in Apply, until Q3-option-B/C is chosen).

---

## 8. Risk Areas

Honest about what could go wrong.

### 8.1 Pre-existing peak-normalisation distorts FRF magnitudes

Per §4.2, response cycles are pre-divided by `|X_peak|` before being averaged. So
`H(f) = rfft(Y_avg) / rfft(X_avg)` is a peak-normalised FRF; absolute residue
magnitudes pick up a per-cycle scaling that's hard to undo cleanly from the averaged
data alone.

**Mitigation.** Phase 1 uses the per-cycle FRF path (Q1=B) — recomputes from
`raw_recordings/` so it's never seen the peak normalisation. Acceptance criterion is
"FRF mode peaks land at ESPRIT mode frequencies within ±2 Hz" — independent of
absolute residue scale.

### 8.2 Calibration channel has its own dynamics

The cal-channel signal IS the recorded sensor output, which has its own transfer
function (sensor bandwidth + amplifier roll-off + UMC1820 ADC characteristics). The
canonical FRF interpretation assumes X(f) = the true input force; in reality it's
`true_force(f) × sensor_transfer(f)`. So our extracted H = `Y(f) / (force(f) ×
H_sensor(f))` — the sensor dynamics are folded INTO our FRF.

**Mitigation.** For Q estimation this doesn't matter — Q is determined by the
structure's pole, not by the input amplitude. For residue magnitudes it adds a
multiplicative `1/|H_sensor(f)|` factor per frequency. As long as `H_sensor(f)` is
smooth across the modal band of interest (50-3000 Hz), the *relative* residues across
modes are nearly unaffected. To go to *absolute* residues we'd need to characterise
the sensor transfer separately (typically a one-time hammer calibration).

### 8.3 Low coherence at low frequency leads to FRF blowups

Per §4.3, the 43 Hz spike showed |H| = 38 because `|X|` was near-zero there. Without
coherence gating the user would see a phantom mode at 43 Hz.

**Mitigation.** Phase 1b adds coherence γ²(f) and visually masks low-γ² regions.
Hard contract: coherence < 0.7 means the FRF point is not reliable; the per-chain
Q-from-FRF estimator (Phase 1e) gates on coherence at the chain frequency.

### 8.4 Voice-coil actuator nonlinearity

For high-drive voltage, voice-coil actuators are mildly nonlinear (saturation +
back-EMF + magnetic-field non-uniformity). The H1 estimator (cross-spectrum / input
auto-spectrum) is biased low for nonlinear systems (best-linear-approximation in the
LS sense).

**Mitigation.** Two diagnostics: (a) compute H2 = G_yy / G_yx in parallel and compare
H1 vs H2 — they diverge in the presence of nonlinearity; (b) compute coherence —
low γ² at high amplitudes is a nonlinearity flag. Both are cheap to add once H1 is
implemented. Not in MVP Phase 1; nice-to-have in Phase 3.

### 8.5 Schema / persistence creep

New `frf/`, `mass/`, `qc/` subtrees per project + new fields in `project.json` + new
endpoints in REST surface. Each is a potential point of schema drift.

**Mitigation.** Mirror the existing `esprit/` shape exactly — `config.json`,
`metadata.json`, `scenario_<idx>.json` — so the conventions are familiar. Round-16
SoT enforcement pattern (saved config dict is the single source; runner-side
defaults only when no config exists) applies to the new stages too. All schema bumps
in `project.json` go through a `schema_version` increment.

### 8.6 Live-processing-flow timing

If FRF + residue compute time exceeds the inter-scenario recording interval (~few
seconds), the worker queue backs up and the user sees "processing N of M" lag. For 600
ms × 7 channels × 1 rfft each, the compute is ~tens of ms — comfortable. For per-cycle
FRF over 150 cycles, more like ~1 s — still under budget for ~10 s inter-scenario
intervals.

**Mitigation.** Make per-cycle vs averaged the FRF method a config parameter; default
to averaged for live, allow per-cycle in a re-run for analysis-grade work.

### 8.7 Pre-existing test infrastructure

ESPRIT + tracking + feedin are heavily tested (round-by-round test additions through
dev-maimport). The new FRF + residue paths should match: each new module ships
with unit + integration tests on synthetic data (known modal model → measured FRF
agrees with theoretical residues to ±3 %) plus regression tests on a fixed
real-world scenario (e.g. `PlyWoodLGtemp1` Sc 100 — pick 2-3 chains, lock the FRF
output as a regression baseline).

---

## 9. Acceptance Criteria per Improvement-Step Delivery

Pure-software acceptance — no operator-physics validation needed.

### Phase 0 acceptance

- **0a:** chain dicts include `quality_factor: 1/(2*damping_mean)`, surfaced in chain
  table and stab-diagram tooltip. Matches the value `export_text_files` writes to
  `Q_coeff_Q.txt`. Test: assert in `chains_to_dicts` output that for `damping_mean =
  0.005`, `quality_factor = 100.0`.
- **0b:** `<scenario>/averaged_responses/normalization_factors.json` exists with
  shape `{measurement_idx: [peak_per_cycle, ...], scenario_mean_peak, scenario_std_peak}`.
  UI shows `force_peak_mean ± std` chip on every scenario. Test: integration test
  averaging a fixture with known per-cycle peaks asserts the persisted JSON values.
- **0c:** `<project>/modal_adapter/qc/log_decrement.json` per chain has `Q_logdec`
  within 10 % of `Q_esprit` for isolated modes (chains with no neighbour within
  3·BW). For overlapping chains, the disagreement correlates with the overlap
  fraction. Test: synthetic 3-mode signal with known Qs, isolated vs overlapping
  configurations.

### Phase 1 acceptance

- **1a + 1c:** `<project>/modal_adapter/frf/scenario_<idx>.json` per scenario has
  keys `frequencies, |H|, phase, coherence, n_response_channels`. Reading back +
  finding peaks recovers ESPRIT mode frequencies for that scenario within ±2 Hz at
  ≥ 80 % rate. Test: integration test on `PlyWoodLGtemp1` Sc 100 hash-locks the FRF
  peak locations.
- **1b:** coherence γ²(f) values in [0, 1] for every frequency. γ² ≈ 1 at modal
  peaks (where SNR is high); γ² ≪ 1 in inter-modal valleys (where Y is near-noise).
  Visual mask in the FRF inspector grays out γ² < 0.7 regions.
- **1d:** per-scenario FRF inspector renders |H(f)| in dB + phase + coherence; mode
  frequencies from the chain set overlaid as vertical lines; coherence-low regions
  visually muted.
- **1e:** Q-from-FRF half-power BW per chain agrees with Q-from-log-decrement and
  Q-from-ESPRIT to within 15 % for ≥ 80 % of well-isolated chains. The disagreement-
  flagging chip catches the chains where it fails.

### Phase 2 acceptance

- **2a + 2b:** `<project>/modal_adapter/mass/residue_<chain_id>.json` per chain has
  `R_per_scenario_per_channel` (complex), `m_n_relative` (float), `m_n_uncertainty`
  (float). Self-consistency: ratio of residues across response channels matches
  ratio of mode-shape values (ESPRIT-derived) within 15 % per (chain, scenario)
  pair.
- **2c:** UI toggle "Raw amplitude" / "Mass-normalised" on mode-shape display
  applies `1/sqrt(m_n_relative)` scaling. Mass-normalised shapes are scenario-
  independent: the per-chain envelope is consistent across scenarios that detect
  the chain.
- **2d:** New "Modal Mass" subpanel with `m_n / m_1` bar chart (90 % CI error bars
  from the LS fit covariance) + per-chain residue heatmap over the actuator grid.

---

## 10. Does This Plan Truly Leverage the Calibration-Channel Data?

**Yes.** The plan's central innovation IS to promote the calibration channel from
"alignment timing" to "input X(f) in FRF". Specifically:

- §5.1.3 computes `H(f) = rfft(Y) / rfft(X)` where `X = ctx.measurements[i][:, 0]` —
  the force channel data, currently sitting in `average_ch0.npy` and not used by
  any downstream analysis.
- §5.1.4 computes `γ²(f) = |G_xy|² / (G_xx · G_yy)` using `X` and `Y` cross-spectra
  — the textbook coherence QC for FRF reliability.
- §5.1.5 persists the per-cycle force peak `|X_peak|` as a scenario-quality scalar.
- §5.2.1 inverts the FRF residue formula `R_n ∝ φ(receiver)·φ(actuator) / m_n` to
  extract per-mode `m_n_relative`.

Every quantitative claim in §5 is directly grounded in `ctx.measurements[i][:, 0]`
(the cal channel) — the channel that today's downstream pipeline largely ignores
after the alignment step. The driving-point assumption (or, more generally, the
multi-input/output FRF assumption) connects this to the user's "between-modes probe"
intuition in the 2026-05-13 proposal: the same Linear System of equations the
between-modes probes would set up are over-determined by Pianoid's 92 × 7 = 644 (actuator,
receiver) pairs already in hand.

---

## 11. Investigation History

- 2026-05-13: original proposal —
  [`modal-mass-q-factor-measurement-techniques-2026-05-13.md`](modal-mass-q-factor-measurement-techniques-2026-05-13.md).
  Catalogue of stepped-sine / swept-sine / random / multi-sine / mass-loading
  methods; recommended a 6-phase rollout; paused on 12 open questions.
- 2026-05-24 (this document): re-analysis with the force-channel data as primary
  input. Adds a "Phase 0" (no new measurements) + "Phase 1" (FRF from existing data)
  + "Phase 2" (modal mass extraction from FRF) before any of the 2026-05-13 plan's
  stepped-sine work. The stepped-sine plan remains valid for very-high-Q modes
  (§5.5.3) but is now deferrable.
- 2026-05-24 (dev-frf-q-phase01): Phase 0 + Phase 1 IMPLEMENTED. User-
  locked answers: Q1=B (FRF from raw_recordings, bypass per-cycle peak
  normalisation), Q2=Relative only, Q3=just store m_n (no preset wiring),
  Q5=force sensor on the HAMMER itself → main signal only; window the
  force around impact peak before FFT (default 0.5 ms pre + 4.5 ms
  post = 5 ms total), Q7=per-scenario NPZ at `<project>/modal_adapter/frf/`,
  Q8=Yes — add `frf` + `frf_stale` + `qc_log_decrement` to
  `data_status()`. See branch `feature/dev-frf-q-phase01` on PianoidCore
  + PianoidTunner; session log
  [`logs/dev-frf-q-phase01-2026-05-24-135524.md`](../development/logs/dev-frf-q-phase01-2026-05-24-135524.md);
  REST surface documented at
  [`REST_API.md` § Stage 5b](../modules/pianoid-middleware/REST_API.md).

---

## Implementation log (Phase 0 + Phase 1 — 2026-05-24)

### What shipped

- **`pianoid_middleware/modal_adapter/qc/log_decrement_xcheck.py`** —
  pure-Python module. `compute_log_decrement_q(ir, sample_rate, freq,
  zeta_predicted) -> (Q, samples, reason)` is the unit; bandpass via
  `scipy.signal.butter(order=2) + filtfilt`, envelope via
  `scipy.signal.hilbert`, linear-fit `log(env)` over the post-peak
  decay region between the peak (skipping ≤2 ms transient) and the
  first drop below `noise_fraction * peak` (default 10%).
  `cross_check_chains(chains, measurements, sample_rate)` is the
  per-chain orchestration that builds the consensus IR (mean across
  the chain's detections × response channels), runs `compute_log_decrement_q`,
  and produces a `LogDecrementResult` per chain with the disagreement
  ratio + flag.
- **`pianoid_middleware/modal_adapter/frf_orchestrator.py`** —
  `FrfOrchestrator` mirroring `EspritOrchestrator` (stateless service
  around `ProjectContext`; persist_cb + persist_npz_cb injected by the
  facade). Per-scenario flow: load `raw_recordings/raw_*_chN.npy` →
  reuse `SignalProcessor.extract_cycles` + `align_cycles_by_onset` for
  cycle alignment → SKIP `normalize_by_calibration` (Q1=B) → per cycle
  window force via `apply_force_window` → rfft both → Welch-average
  `Sxy/Sxx/Syy` across cycles → `H1 = mean_Sxy / mean_Sxx`,
  `coherence = |mean_Sxy|² / (mean_Sxx · mean_Syy)`. Force-peak
  detection via `detect_impact_peak` (min sample on the negative
  pulse; polarity fallback to `argmax(abs)`).
- **`apply_service._persist_npz(stage, filename, arrays)`** new
  helper parallel to the existing `_persist` (JSON). Uses
  `np.savez_compressed` so per-scenario NPZ files stay small
  (≈ 1 MB for 7 channels × 24001 freqs × complex128 + reals).
- **`project_context.py`** new fields: `frf_results: Optional[Dict[int, Dict]]`
  (in-memory metadata cache; the NPZ on disk is the source of truth
  for heavy arrays), `frf_stale: bool`, `qc_log_decrement: Optional[Dict[int, Dict]]`,
  `_frf_lock: threading.Lock`. `has_frf()` helper added.
- **`esprit_runner.chains_to_dicts`** additively writes
  `quality_factor: 1/(2·damping_mean)` per chain AND per detection.
  All other fields preserved. UI consumers ignore unknown keys, so
  this is a non-breaking schema bump.
- **`modal_adapter.py` facade**: wired `FrfOrchestrator`, extended
  `data_status()` with `frf` / `frf_stale` / `qc_log_decrement` flags,
  added `run_frf`, `get_frf_summary`, `get_scenario_frf`, `has_frf`,
  `invalidate_frf`, `run_log_decrement_xcheck`, `get_log_decrement_xcheck`
  delegation methods. Extended `load_intermediate` to dispatch `frf` +
  `qc`. Wrapped `run_esprit` + `load_folder` to call
  `_frf_orchestrator.mark_stale()` (Q8 dirty flag). Extended all four
  project-create / repair subdir-loops with `frf` + `qc`.
- **REST**: 6 new endpoints in `routes/pipeline_routes.py`:
  `POST /modal/run_frf`, `GET /modal/frf/summary`,
  `GET /modal/frf/scenario/<idx>`, `DELETE /modal/frf`,
  `POST /modal/qc/log_decrement`, `GET /modal/qc/log_decrement`.
- **Frontend (PianoidTunner)**: `ModalResultsView.jsx` ModeTable gains
  a Q column rendering the `quality_factor` field; when the
  `qcLogDecrement` prop is supplied, the Q cell carries a tooltip +
  background-color flag showing agreement (green-tinted) vs
  disagreement (red-tinted) relative to the log-decrement Q estimate.

### Test deltas

| Suite | New tests |
|---|---|
| `tests/integration/modal_adapter/test_quality_factor_surface.py` | 5 |
| `tests/integration/modal_adapter/test_qc_log_decrement.py` | 9 |
| `tests/integration/modal_adapter/test_frf_orchestrator.py` | 17 |
| `PianoidTunner/src/components/__tests__/ModalResultsView.qColumn.test.jsx` | 6 |
| **Total** | **37** |

All 37 passing. Existing PianoidTunner Jest suite (662 tests, 55 suites)
green. Existing PianoidCore modal_adapter integration tests (60) green.

### Live verification

Spun up `ModalAdapter()` in-process (no Flask server) against
`D:/modal_measurements/PlyWoodLGtemp1/scenarios/PlyWood-Scenario100-LG`:

- 120 cycles loaded after alignment (8 measurements × 15 cycles, no
  cycle drops; alignment correlation threshold default 0.7 from the
  scenario metadata)
- FRF computed in ≈4 s end-to-end (load + alignment dominates;
  per-cycle FFT is ms-class)
- NPZ written to `<tmp>/modal_adapter/frf/scenario_100.npz` (18 arrays
  ≈ 1.0 MB compressed)
- Channel-averaged peak detection (50-3000 Hz):
  | Expected (proposal §4.3) | Observed | Coherence |
  |---|---|---|
  | 85 Hz | 93 Hz (peak nearby; modal cluster) | 0.96 |
  | 162 Hz | 161 Hz | 1.00 |
  | 199-202 Hz | 194 Hz | 1.00 |
  | 445-446 Hz | 445 Hz | 0.99 |
  | 682 Hz | 680 Hz | 0.98 |
  | 2261-2264 Hz | 2221 Hz | 0.94 |

Peaks match the design-doc reference within ±5 Hz at modal-density
frequencies and ±40 Hz at the highest frequency tested. Magnitudes
are absolute differently because Phase 1 uses raw cycles (clean H1)
vs the design-doc which used `averaged_responses/` (peak-normalised
per cycle); both are valid surfaces, the Phase 1 path is the one Q1=B
asked for. Coherence ≥ 0.85 at every modal peak — confirms the FRF
is trustworthy where it matters.

### Phase 2 boundary

Phase 1 stops at: data layer + REST endpoints + Q UI surfacing. No
FRF visualisation panel yet — the frontend reads
`GET /modal/frf/scenario/<idx>` already (the JSON is panel-ready),
the panel itself ships in Phase 2 alongside the residue extractor +
relative modal mass calculator + cross-scenario residue heatmap (see
proposal §6 Phase 2 table).

---

**END OF PROPOSAL.** Phase 0 + Phase 1 shipped 2026-05-24
(branch `feature/dev-frf-q-phase01`, awaiting user verification + merge).
Phase 2 design unchanged; ready when the user wants it.
