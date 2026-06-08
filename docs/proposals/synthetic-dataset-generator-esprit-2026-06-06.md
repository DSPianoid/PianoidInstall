# Synthetic Dataset Generator for ESPRIT-Tracker Validation

**Status:** **PHASES 1-3 + 4a SHIPPED (2026-06-08, dev-synth1) — BACKEND COMPLETE.** Phase 4b
(frontend) PENDING (do NOT archive). **Phase 4a** = the REST routes (`synth/synth_routes.py`,
on `modal_bp`): `POST /modal/measurements/synthesize` (body → forward_model + dataset_writer →
import a Measurement, `synthetic:true` → 201) + `POST /modal/measurements/<id>/validate` (run
the validate harness → the `ValidationScorecard` JSON the frontend charts render). Reuses
`import_folder_as_measurement` unchanged. 8/8 route tests (Flask test_client). The full REST
contract (request schemas + scorecard JSON shape) is in the dev-synth1 session log + the
Phase-4a report — the API the frontend agent consumes. **Phase 3** = the validation harness
(`synth/validate.py`): runs the REAL,
unchanged `EspritRunner` on a synthetic dataset → matches known↔detected (`match_modes`) →
scores freq/Q/MAC/recall/precision (`precision_scorecard`), using the INDEPENDENT
`synth.metrics.compute_mac` for SCORING (never the estimator's own `band_merging.compute_mac`
— circular-dep). ★Lowest-band-first surfaced a real signal-conditioning regime: the default
receivers sat on plate-boundary NODES (simply-supported eigenmodes are 0 on the boundary) →
dead channels poisoning ESPRIT; FIXED by insetting the forward-model default receivers into
the plate INTERIOR (physics untouched, P2 parity still bit-exact) + a per-channel
dead-channel diagnostic. **Acceptance both green:** clean lowest-band hits thresholds (median
freq err 7e-5/1.3e-4 < 1 %, median MAC 0.995 > 0.95, recall 0.92 > 0.9 on 5×5 & 7×7); a
band-mismatched run surfaces recall 0.0 (scorecard catches the config gap). 5/5 integration
tests; 367 no-regression. `tests/integration/test_synth_validate.py`. (Q/damping is reported
per-mode but not gated — ESPRIT's damping estimate is noisier than frequency.)
Phase 1 = the pure-function core (all 17 §7.1 fns) in
`PianoidCore/pianoid_middleware/modal_adapter/synth/` (geometry / pulse / oscillator /
metrics) with the 17 manifest tests at `tests/unit/test_synth_*.py` — **dual-backend gate
356/356 green on numpy AND cupy** (DeepSeek shipped 16 routine fns first-try @ $0.011; Opus
authored `integrate_modal_oscillator` #8; §3.4.2 parity < 1e-2). **Phase 2** = the GPU
forward-model orchestrator (`synth/forward_model.py`, xp-switch mirroring
`esprit_core._to_gpu_or_cpu`; loops impacts×modes → oversample → `scipy.signal.decimate` →
48 kHz; grid/modes parametric, default 7×7 + 12 impacts) + the Measurement-layout writer
(`synth/dataset_writer.py`) + `tests/integration/test_synth_forward_model.py`. **Acceptance:
CPU↔GPU parity BIT-EXACT; live `import_folder` round-trip → HTTP 201** (3 scenarios / 25 ch /
48 kHz — confirms the proposal §9 npy `(samples,n_channels)` float32 contract via the real
importer); 11/11 integration tests. All on branch `feature/synthetic-dataset`. Stats ledger:
`D:\tmp\synthds-build\{ledger.json,LEDGER.md}`. Remaining: Phase 3 (validation harness —
real ESPRIT+tracking on synthetic data → scorecard, lowest-band first), Phase 4 (frontend
Synthesize section + comparison charts).
Original design context (signed off 2026-06-06): CuPy backend, analytic-core mode shapes,
inline scorecard, extend-grid, thresholds-as-recommended; iterative force-driven physics
(§3.4); the A/B delegation manifest (17 fns) built + validated at `D:\tmp\synthds-ab\`.
**Author:** `/analyse` (ana-synthds), 2026-06-06.
**Scope:** A tool that synthesises a *ground-truth* multi-channel impulse-response
dataset from a soundboard with **known** modes (frequency, quality factor, spatial
shape), feeds it through the existing measurement → ESPRIT → tracker pipeline, and
scores how accurately the known parameters are reconstructed. Frontend entry point: a
**Synthesize** section in the Modal Adapter (MA) **Collect** subpanel.

---

## 1. Objective & Motivation

The Modal Adapter extracts vibrational modes (frequency `f`, damping ratio `zeta`,
complex spatial shape `phi`) from real impulse-response recordings of a piano
soundboard using ESPRIT, then tracks those modes across excitation points. Today there
is **no ground-truth oracle**: every validation of ESPRIT/tracker quality has been
against real measurements where the true modes are unknown (the
`docs/research/*PRESENTATION*` slides describe "FEA-vs-measured" comparison, but no
in-repo synthetic forward model exists — confirmed by source survey, see §11).

This feature builds that oracle:

1. Define a synthetic soundboard: a 2-D grid with a **known** modal basis
   `{(f_m, Q_m, phi_m(x,y))}`.
2. Emulate a hammer impact at a chosen point; model each mode's damped oscillation.
3. Render the response at chosen receiver points → a `(T, n_channels)` array per impact.
4. Feed the synthetic responses through the **real** pipeline (ESPRIT → tracking).
5. Compare reconstructed `(f, Q, phi)` against the known values → a per-parameter
   **precision metric**.

The result is a regression harness: any change to ESPRIT, band config, or the tracker
can be scored against modes whose true values we authored.

---

## 2. The load-bearing fact: the pipeline I/O contract

This is the single most important fact — the synthetic dataset must match the **real**
pipeline's input format exactly, or the validation is meaningless. Confirmed against
docs (not inferred from source):

### 2.1 ESPRIT INPUT (what the synthetic generator must produce)

Per [`MODAL_ADAPTER_GUIDE.md` § Data Formats → Input](../guides/MODAL_ADAPTER_GUIDE.md#data-formats)
and [`MODAL_ADAPTER_GUIDE.md` § Project Management](../guides/MODAL_ADAPTER_GUIDE.md#project-management):

| Item | Contract | Source |
|------|----------|--------|
| Per scenario | `(T, n_channels)` numpy array — multi-channel impulse response | Guide § Data Formats → Input |
| On disk | `{project}/measurements/scenario_<idx>.npy` (combined `(T, n_channels)`) | Guide § Project Management |
| `T` | number of time samples | Guide § Data Formats |
| `n_channels` | measurement channels (accelerometers/mics along the bridge + optional force) | Guide § Data Formats |
| Sample rate | `project.json.sample_rate` (e.g. 48000 Hz). REST note: a value `< 1000` is multiplied by 1000 | REST_API.md:345 |
| One scenario | one **impact / excitation point** (the bridge/key position being struck) | Guide § Tracking Section ("the same physical mode observed at different piano keys") |
| Channel roles | `response` (soundboard sensors → feedin), `force` (hammer force → normalize), `skip`. Calibration channel maps to `reference`. | Guide § Channel roles; MODAL_COLLECTION.md Round 8 |

So a synthetic "measurement" = a set of scenarios, each scenario = one impact point,
each producing a `(T, n_channels)` array sampled at `sample_rate` over `n_channels`
fixed **receiver** positions.

### 2.2 The signal model ESPRIT assumes (so the forward model matches)

Per [`MODAL_ADAPTER_GUIDE.md` § Algorithm Overview](../guides/MODAL_ADAPTER_GUIDE.md#algorithm-overview)
and [`OVERVIEW.md` esprit_core](../modules/pianoid-middleware/OVERVIEW.md): ESPRIT
fits each channel's time series as a **sum of exponentially damped sinusoids**. Poles
are estimated in discrete time, conjugate-paired (real signal), and converted to
continuous time by logarithmic mapping → natural frequency in Hz + dimensionless
damping ratio `zeta`. The per-channel **complex amplitude** of each damped sinusoid is
the mode shape entry.

The continuous-time model for channel `c`, summing over modes `m`:

```
y_c(t) = sum_m  Re{ A_m * phi_m(r_c) * exp( s_m * t ) } + noise
       = sum_m  |a_mc| * exp(-zeta_m * omega_m * t)
                * cos( omega_d,m * t + arg(a_mc) )
```

where:

- `omega_m = 2*pi*f_m` (undamped natural angular frequency, rad/s),
- `zeta_m` = damping ratio (dimensionless), related to quality factor by
  **`Q_m = 1 / (2*zeta_m)`** (standard, valid for light damping),
- `s_m = -zeta_m*omega_m + j*omega_d,m` (continuous-time pole),
- `omega_d,m = omega_m * sqrt(1 - zeta_m^2)` (damped angular frequency),
- `a_mc = A_m * phi_m(r_c)` = complex modal participation at receiver `c` =
  (global modal excitation amplitude) × (mode shape sampled at receiver `c`).

This **mirrors ESPRIT's preset-conversion math** exactly
([Guide § Preset Conversion](../guides/MODAL_ADAPTER_GUIDE.md#preset-conversion)):
`delta = 2*pi*zeta / sqrt(1 - zeta^2)` (log decrement); `dt = 1/sample_rate`. Generating
with the same model ESPRIT inverts guarantees the validation tests the *estimator*, not
a model mismatch.

### 2.3 Excitation → modal amplitude (the impact model)

Modal analysis of a forced linear system: striking the soundboard at impact point
`r_i` with a force pulse `g(t)` excites mode `m` with amplitude proportional to the
**mode shape sampled at the impact point**:

```
A_m  ∝  phi_m(r_i) * G(omega_m)
```

where `G(omega_m)` is the force pulse's spectrum evaluated at the mode frequency (a
short pulse is near-flat across the audio band; a longer pulse rolls off the treble).
This is the physically-correct reciprocity: a mode is excited in proportion to how much
the impact point moves in that mode, and observed in proportion to how much each
receiver moves in that mode (`phi_m(r_c)`). The product
`phi_m(r_i) * phi_m(r_c)` is the classic modal transfer-function residue.

### 2.4 ESPRIT OUTPUT (the ground-truth comparison target)

Per [`MODAL_ADAPTER_GUIDE.md` § ESPRIT Extraction Output](../guides/MODAL_ADAPTER_GUIDE.md#data-formats)
and [`OVERVIEW.md` § Complex Mode Shape Persistence](../modules/pianoid-middleware/OVERVIEW.md#complex-mode-shape-persistence):

| Field | Type | Meaning |
|-------|------|---------|
| `frequencies` | `ndarray (n_modes,)` | natural frequency, Hz |
| `damping_ratios` | `ndarray (n_modes,)` | dimensionless `zeta` |
| `mode_shapes` | `complex ndarray (n_modes, n_channels)` | complex spatial pattern per mode |
| `poles` | `complex ndarray (n_modes,)` | continuous-time poles |

Persisted per scenario as `scenario_{idx}.json` (freq/damping/amplitudes/real
shape magnitudes) + `scenario_{idx}_shapes.npy` (complex128 `(n_modes, n_channels)`,
lossless phase).

### 2.5 Tracking OUTPUT (cross-scenario ground truth)

Per [`MODAL_ADAPTER_GUIDE.md` § Tracking Output](../guides/MODAL_ADAPTER_GUIDE.md#data-formats):
`ModeChain` objects link per-scenario detections into one physical mode across impact
points: `frequency_mean`, `damping_mean`, `stability` (`stable`/`semi-stable`/
`weak`/`spurious`), `detections` (per-scenario map). Chain quality
`quality.shape_consistency` = mean pairwise MAC across the chain's detections.

### 2.6 The MAC metric (central to validation)

The Modal Assurance Criterion compares two complex mode-shape vectors. Confirmed from
[`esprit-channel-timing-analysis-2026-05-08.md`](archive/esprit-channel-timing-analysis-2026-05-08.md):155
and [`MODE_TRACKING_REDESIGN.md`](../development/archive/MODE_TRACKING_REDESIGN.md):175
(`compute_mac`):

```
MAC(s1, s2) = |s1^H · s2|^2 / ( (s1^H · s1) · (s2^H · s2) )      ∈ [0, 1]
```

1.0 = identical shapes (up to complex scale); 0.0 = orthogonal. This is the natural
shape-error metric for the validation criterion (§5).

> **No doc gap on the I/O contract.** The input format, signal model, output schema,
> and MAC definition are all explicitly documented. This is the rare case where the
> load-bearing fact is *fully specified* — the synthetic model can be authored with
> confidence. The one place to confirm-by-measurement during Phase 3 is the exact
> on-disk `scenario_N.npy` dtype/orientation the loader expects (float32 vs float64;
> `(T, C)` row-major) — trivially verifiable by writing one array and round-tripping it
> through `POST /modal/measurements/import_folder` before trusting the harness.

---

## 3. Soundboard simulation physics (the forward model)

### 3.1 Spatial domain

A rectangular grid of `n_rows × n_cols` points with square spacing `dx = dy`
(millimetres) — **identical** to the existing `MappingConfig` grid layout (§6). Each
populated grid cell has a physical coordinate `[x_mm, y_mm]` (row-major), exactly as
`GridLayoutEditor` already produces (`point_coordinates`).

### 3.2 Known modal basis

The user supplies, per mode `m`:

| Param | Symbol | Units | How entered (frontend §6) |
|-------|--------|-------|---------------------------|
| Frequency | `f_m` | Hz | numeric |
| Quality factor | `Q_m` | dimensionless | numeric (→ `zeta_m = 1/(2 Q_m)`) |
| Spatial shape | `phi_m(x, y)` | real, dimensionless | image-import OR analytic (plate eigenmode) OR drawn |
| Global amplitude | `A0_m` | dimensionless | numeric (optional; default 1.0) |

`phi_m` is a real-valued field over the grid (the synthetic ground truth is purely
real/standing-wave; ESPRIT will report complex shapes whose phase should collapse to
±1 sign flips — itself a useful test that the pipeline recovers real shapes from real
data). Shape representations:

- **Analytic** — closed-form rectangular-plate (simply-supported) eigenmodes
  `phi_{p,q}(x,y) = sin(p*pi*x/Lx) * sin(q*pi*y/Ly)` for integer `(p, q)`. Cheap,
  exact, ideal for the first ground-truth sets.
- **Image-import** — a greyscale image (per the user's spec) mapped to `[-1, +1]` over
  the grid bounding box (bilinear-resampled to the grid). Lets the user paint arbitrary
  nodal patterns.
- **Drawn** — a coarse paint-on-grid editor (reuse the `GridLayoutEditor` cell grid,
  values instead of booleans). Lower priority.

### 3.3 Impact (excitation) model — modal force

A force pulse `F(t)` is applied at impact point `r_i`. Pulse shapes:

```
F(t) = raised-cosine (Hann) pulse of duration tau, OR
       half-sine of duration tau   (peak 1.0; arbitrary tau)
```

Each mode `m` is driven by a **modal force** = the spatial force projected onto the
mode shape at the impact point:

```
f_m(t) = phi_m(r_i) * F(t)          (modal_force_projection)
```

This is the physically-correct modal-analysis forcing: a mode is driven in proportion
to how much the impact point participates in that mode. Because the iterative
integrator (below) takes the **full force time series**, arbitrary pulse shape and
duration are handled exactly — no flat-spectrum / convolution approximation is needed.

### 3.4 Per-mode oscillation — ITERATIVE force-driven model (exact 2-pole recurrence)

**(User-specified, 2026-06-06.)** Each mode is a damped harmonic oscillator with
modal displacement `q_m(t)`, unit modal mass, driven by `f_m(t)`:

```
q_m'' + 2*zeta_m*omega_m*q_m' + omega_m^2*q_m = f_m(t)
```

with `omega_m = 2*pi*f_m`, `zeta_m = 1/(2*Q_m)`. Integrate **sample-by-sample** via
the **exact discrete 2-pole recurrence** — the closed-form zero-order-hold (ZOH)
discretization of the continuous oscillator, which is *error-free* (not an Euler/RK
approximation). With state `x = [q, q']` and step `h = dt`:

```
x[n+1] = Ad @ x[n] + Bd * f[n]        (sequential IIR — q[n] read before f[n] applied)
```

The closed-form coefficients (underdamped `0 <= zeta < 1`), with
`sigma = zeta*omega`, `omega_d = omega*sqrt(1-zeta^2)`, `a = exp(-sigma*h)`,
`c = cos(omega_d*h)`, `s = sin(omega_d*h)`:

```
Ad = a * [[ c + (sigma/omega_d)*s,         s/omega_d            ],
          [ -(omega^2/omega_d)*s,    c - (sigma/omega_d)*s      ]]
Bd = A^{-1} (Ad - I) [0,1]^T,   A = [[0,1],[-omega^2, -2*zeta*omega]]
```

> **Validated machine-exact (this analysis, private reference):** the closed-form `Ad`
> matches `scipy.linalg.expm(A*h)` to **3.6e-12**, and the full integrator matches
> scipy's own ZOH discretization (`cont2discrete(method="zoh")` + `dlsim`) to
> **9.5e-13** (worst case over `f ∈ {50,440,3000} Hz`, `zeta ∈ {0.001,0.02,0.2}`).
> So the recurrence IS the exact ZOH solution — the delegated function needs only
> scalar coefficients, no matrix exponential at runtime.

**Oversample → decimate.** Integrate at a high internal rate `dt <= 0.01 ms`
(`>= 100 kHz`; default 192 kHz) so the recurrence is well inside the stable, accurate
regime for the full 30 Hz–6 kHz band, then **decimate** the summed receiver output to
the ESPRIT sample rate (48 kHz) with an anti-alias filter (`scipy.signal.decimate`,
a non-delegated orchestration step — see §7.2). The high internal rate also keeps the
ZOH input-hold error on the (already smooth) pulse negligible.

### 3.4.1 Receiver response

The displacement at receiver `r_c` is the modal superposition:

```
y(r_c, t) = sum_m phi_m(r_c) * q_m(t)        (accumulate_receiver_response)
```

Stacking modes `(M, T)` against receiver shapes `(M, C)` → output `(T, C)` (the ESPRIT
input orientation, §2.1). `phi_m(r_c)` and `phi_m(r_i)` are the mode shape sampled at
the receiver / impact points (`sample_shape_at_points`, §3.2).

### 3.4.2 Closed-form PARITY cross-check (retained)

The closed-form damped cosine
`y_mc(t) = a_mc * exp(-zeta*omega*t) * cos(omega_d*t + arg)` remains as a **fast parity
oracle**: for a narrow/impulsive excitation the iterative `q_m(t)` must equal the
closed-form free-decay (validated to 7.3e-3 impulse-response rel-err in this analysis).
It is *not* the production path (it cannot handle arbitrary pulse duration without
convolution) — it is a cheap independent check that the IIR integrator is correct, and
a delegated function in its own right (`single_damped_oscillator_closed_form`).

### 3.4.3 Optional realism knobs (each a clearly-scoped pure function)

- **Measurement noise** — additive white Gaussian at a target SNR (`snr_scale_noise`);
  the QC/`T_eff` machinery in the pipeline expects a noise floor.
- **Force channel** — one channel carrying `F(t)` itself (the "force" role), so the
  feedin-normalization path is exercised.
- **Sensor gain/position jitter** — per-receiver scale, to test MAC robustness.

### 3.5 Why this is the right model

The iterative oscillator is the **exact time-domain solution** of the same
damped-mode ODE whose impulse response ESPRIT fits as a damped sinusoid (§2.2) — so the
synthetic data has **no** model mismatch with the estimator's assumptions on the clean
baseline. Any reconstruction error is then attributable to the estimator (band config,
model order, SVD rank, decimation, noise), which is exactly what the validation
measures. The iterative form (vs the closed-form) additionally lets the user author
**arbitrary impact pulse shapes/durations** faithfully — a real hammer is not a Dirac —
and the closed-form parity check guards the integrator's correctness.

---

## 4. GPU backend choice — with the env reality

> **SIGNED OFF 2026-06-06 — CuPy primary + numpy CPU fallback (NOT TensorFlow).** The
> user accepted the recommendation below. JS/React functions (frontend, P4) are
> Jest-gated separately. The rest of this section is the rationale of record.

The user originally preferred **TensorFlow**, alternatively **CuPy**. Here is the
measured reality of `PianoidCore/.venv` (probed 2026-06-06):

| Package | Installed? | Version | Notes |
|---------|-----------|---------|-------|
| `numpy` | yes | 2.2.6 | — |
| `scipy` | yes | 1.16.1 | FFT, signal, Hilbert already used by the pipeline |
| **`cupy`** | **yes** | **14.0.1** | CUDA runtime **12.9** (12090). Already the GPU backend ESPRIT uses (`esprit_core._to_gpu_or_cpu`). `cupy-cuda12x` pinned in `requirements.txt`. |
| **`tensorflow`** | **NO** | — | not installed; not a transitive dep of anything in the venv |

### Recommendation: **CuPy primary, numpy CPU fallback. Do NOT add TensorFlow.**

Rationale (honest trade-off):

1. **CuPy is already present, proven, and CUDA-12-matched.** ESPRIT itself runs on this
   exact CuPy. The modal_adapter_server already manages CuPy GPU thread-pinning
   (`threaded=False` because "CuPy GPU operations deadlock in non-main threads" —
   [Guide § Architecture](../guides/MODAL_ADAPTER_GUIDE.md#architecture)). The synthetic
   forward model is **embarrassingly parallel** elementwise tensor math
   (`exp`, `cos`, broadcast-multiply, sum-reduce over a `(n_modes, n_receivers, T)`
   tensor) — CuPy's numpy-compatible API expresses it in ~the same code as numpy, with a
   one-line `xp = cupy if use_gpu else numpy` switch (the pipeline's own idiom).
2. **TensorFlow is a heavy, fragile new dependency on this platform.** TF dropped native
   Windows-GPU support after 2.10 (later versions need WSL2 for CUDA on Windows). Adding
   TF risks (a) a ~500 MB+ install, (b) a second CUDA/cuDNN toolchain to keep in lockstep
   with the engine's CUDA 12.x, (c) the documented venv-rebuild fragility where even
   `cupy-cuda12x` silently drops on `--heavy` rebuilds — a TF-GPU stack would be far more
   brittle. For pure elementwise DSP there is **no modelling advantage** to TF's autodiff
   / graph machinery; this is not a training workload.
3. **numpy CPU fallback is free** — the same `xp`-switched code runs on CPU for CI
   machines without a GPU (and the datasets are small enough — see below — that CPU is
   perfectly usable for authoring).

**Scale sanity check.** A typical set: 30 impact points × ~40 modes × 8 receivers ×
(600 ms × 48 kHz ≈ 28 800 samples). The core tensor `(n_modes, n_receivers, T)` per
scenario ≈ 40 × 8 × 28 800 × 8 bytes ≈ 74 MB — trivial for GPU, fine on CPU. GPU pays
off mainly when sweeping many parameter sets for a robustness study. **This is Python
GPU (CuPy), NOT the C++ `pianoidCuda` — no `.cu`/CUDA-kernel build, no `/dev` CUDA
build gate.**

> If the user still wants TF specifically (e.g. to reuse a TF FEA model elsewhere), the
> `xp`-switch design makes a TF backend an isolated add-on later — but it should be a
> deliberate, separate decision, not the default. Flagging this as a **decision point**
> for user review.

---

## 5. Validation criterion (ground-truth vs reconstruction)

The harness runs the synthetic responses through ESPRIT (+ tracking) and matches each
**known** mode to its best **reconstructed** mode, then scores per-parameter error.

### 5.1 Matching (assignment)

Build a cost between each known mode `k` and each detected mode `d`:

```
cost(k, d) = w_f * |f_k - f_d| / f_k            (relative freq error)
           + w_s * (1 - MAC(phi_k_sampled, shape_d))   (shape mismatch)
```

where `phi_k_sampled` = the known shape sampled at the **receiver** points (so it is
directly comparable to the detected `mode_shape (n_channels,)`). Solve the optimal
assignment (Hungarian / `scipy.optimize.linear_sum_assignment`) with a gate
(unmatched known modes = **missed**; unmatched detections = **spurious/false-positive**).
This mirrors the tracker's own MAC-verified cost philosophy
([`MODE_TRACKING_REDESIGN.md`](../development/archive/MODE_TRACKING_REDESIGN.md)).

### 5.2 Per-parameter precision metrics

For each matched pair, per scenario and aggregated:

| Metric | Definition |
|--------|-----------|
| Frequency error | `\|f_k - f_d\| / f_k` (relative, %), and abs (Hz) |
| Q / damping error | `\|Q_k - Q_d\| / Q_k`; equivalently `\|zeta_k - zeta_d\| / zeta_k` |
| Shape fidelity | `MAC(phi_k_sampled, shape_d)` (target ≈ 1.0) |
| Amplitude error | `\|A_k - \|shape_d\|_rms\| / A_k` (optional) |
| **Recall** | fraction of known modes recovered (matched within gate) |
| **Precision** | fraction of detections that matched a true mode (1 − spurious-rate) |

Aggregate to a scorecard: median/p90 freq error, median Q error, median MAC, recall,
precision — per band and overall. A "reasonable precision" pass threshold (user to set;
suggested defaults: median freq err < 1 %, median MAC > 0.95, recall > 0.9) makes it a
**regression gate**.

### 5.3 Tracking validation (cross-scenario)

Because every scenario shares the same known modal basis, the **true** mode-chain
assignment is known (mode `m` appears in every scenario). Compare the tracker's chains
against this ground truth: chain purity (do all detections in a chain belong to the same
true mode?), completeness (does each true mode form one chain spanning the scenarios it
was excited in?), and `frequency_mean`/`damping_mean` error vs the known values. This
directly tests `nuclei_merge`/`sliding_window` quality on data with a known answer.

---

## 6. Frontend: the "Synthesize" section in the Collect subpanel

Per [`pianoid-tunner/OVERVIEW.md` § CollectionSubpanel](../modules/pianoid-tunner/OVERVIEW.md)
and [`MODAL_ADAPTER_GUIDE.md` § Collection Subpanel (Phase 2b)](../guides/MODAL_ADAPTER_GUIDE.md#collection-subpanel-phase-2b),
`CollectionSubpanel.jsx` owns five collapsible sections under
`<CollectionSettingsPanel>`; section components live in
`src/modules/panels/collection/`. The Synthesize feature adds a **6th section**
(`SynthesizeSection.jsx`) — OR a sibling sub-mode toggle ("Record | Synthesize") at the
top of the subpanel (cleaner separation; recommended). It produces a Measurement on
disk just like a real recording, so everything downstream (ESPRIT, tracking) is
unchanged.

### 6.1 Reusing the existing grid tool

`GridLayoutEditor.jsx` (`src/components/GridLayoutEditor.jsx`) is a **controlled,
presentation-only** component (props in, callbacks out — verified by reading the file).
It already produces exactly the spatial substrate we need:

- `gridShape` `[n_rows, n_cols]`, `gridSpacingMm`, `cellMask` `bool[][]`,
- `pointCoordinates` `{ idx: [x_mm, y_mm] }` (row-major).

The Synthesize section reuses it directly for the **soundboard domain**. For point
selection (impact points + receiver points), the cleanest reuse is a **selection-mode
variant** of the same grid: instead of a boolean `populated` mask, each cell can be
tagged `impact` / `receiver` / `none` (a small enum-paint extension). Two options:

- **(a) Extend `GridLayoutEditor`** with an optional `mode="select"` prop + a
  `cellRoles` map (keeps one component; modest change). Recommended.
- **(b) New thin `GridPointSelector.jsx`** that copies the grid-render block and paints
  roles (avoids touching the shipping editor). Safer for the locked editor, more
  duplication.

Either way the output is two coordinate lists — `impact_points: [[x,y],...]` and
`receiver_points: [[x,y],...]` — consumed by the backend synth.

### 6.2 Section UI (MUI dark theme, per project Frontend Standards)

| Control | Component | Notes |
|---------|-----------|-------|
| Soundboard grid (rows/cols/spacing) | reuse `GridLayoutEditor` | defines `Lx, Ly`, dx |
| Mode table (add/remove rows: f, Q, amplitude, shape-ref) | MUI `Table` + `NumInput` | one row per known mode |
| Mode-shape input | image-upload (`<input type=file>`) OR analytic `(p,q)` picker OR draw | per §3.2 |
| Mode-shape preview | ECharts heatmap (reuse `GridHeatmapInset` pattern) | shows `phi_m` over grid; dark theme |
| Impact pulse (shape, duration ms) | MUI `Select` + `NumInput` | reuse `ImpulseShapeChart` ECharts preview idiom |
| Impact + receiver point selection | grid select-mode (§6.1) | paint cells as impact/receiver |
| Noise (SNR dB), sample_rate, duration ms, n channels | `NumInput` | |
| **Synthesize** button | MUI `Button` (contained primary) | POSTs to backend; writes a Measurement |
| Result/validation panel | ECharts + table | optional inline scorecard (or run pipeline + show on Project side) |

All numeric inputs use the existing `NumInput` component; all charts ECharts on
`backgroundColor: 'transparent'` with palette colours — per the project's
`<always_use_dark_professional_theme>` rule.

### 6.3 Wiring to the backend (no new ingest format needed)

The synth backend writes `measurements/scenario_N.npy` + a `metadata/` +
`averaged_responses/average_ch{N}.npy` per scenario (or the flat `scenario_N.npy`
mirror), i.e. a normal RoomResponse/Measurement layout, then the **existing**
Measurement-import / project-create flow takes over. This means **zero changes to
ESPRIT/tracking** and reuse of the entire Measurement entity machinery
(`POST /modal/measurements/import_folder`,
[MODAL_COLLECTION.md § Measurement Import](../modules/pianoid-middleware/MODAL_COLLECTION.md#measurement-import-endpoints-dev-maimport-2026-05-19)).
The ground-truth `{(f,Q,phi)}` is saved alongside (e.g. `synthetic_ground_truth.json`)
for the validation harness.

---

## 7. Component decomposition

### 7.1 DELEGABLE functions (DeepSeek codegen pipeline) — Python + CuPy, xp-agnostic

**(Expanded per user direction 2026-06-06: delegate ALL relevant Python *and* CuPy
functions.)** Every function below is **xp-agnostic** — written against the common
numpy/CuPy subset and taking the array module `xp` as a parameter, so the **same body**
runs `numpy`-in-test and `cupy`-in-prod (a CuPy function with a clear spec + a
numerically-checkable test IS delegable). Claude writes thorough tests first (golden
vectors + property + edge/error); DeepSeek generates the bodies; the tests gate **both**
A/B arms.

**A/B MANIFEST BUILT + VALIDATED:** `D:\tmp\synthds-ab\manifest\` — per function:
`<name>.spec.md`, `<name>.test.py`, `<name>.constraints.md`. Each test validated against
a **private independent reference** (`D:\tmp\synthds-ab\_private_ref\`, NOT shipped in
the manifest — it must stay independent). The iterative 2-pole recurrence is
machine-exact vs scipy ZOH discretization (§3.4).

| # | Group | Function | Spec (one line) | Why pure / xp-agnostic |
|---|-------|----------|-----------------|------------------------|
| 1 | geom | `grid_point_coordinates(n_rows,n_cols,spacing_mm,xp)` | row-major `(N,2)` `[x,y]` mm — mirror of FE GridLayoutEditor | pure geometry, golden-vector |
| 2 | geom | `rect_plate_eigenmode(points_xy,p,q,Lx,Ly,xp)` | `sin(p·π·x/Lx)·sin(q·π·y/Ly)` at points | closed-form field |
| 3 | geom | `sample_shape_at_points(shape_grid,n_rows,n_cols,spacing_mm,points_xy,xp)` | bilinear-sample grid field at `(x,y)`, edge-clamp | pure interpolation, golden-vector |
| 4 | geom | `image_to_shape_grid(gray,n_rows,n_cols,xp)` | NN-resample greyscale → `[-1,1]` flat grid | array resample, deterministic |
| 5 | pulse | `raised_cosine_pulse(n_samples,sample_rate,duration_ms,xp)` | Hann force pulse, peak 1.0, zero-pad | deterministic, known shape |
| 6 | pulse | `half_sine_pulse(n_samples,sample_rate,duration_ms,xp)` | half-sine force pulse | deterministic |
| 7 | **osc** | `oscillator_zoh_coeffs(f_hz,zeta,dt,xp)` | exact ZOH `(Ad,Bd)` 2-pole coeffs (§3.4) | closed-form; machine-exact vs scipy |
| 8 | **osc** | `integrate_modal_oscillator(force,f_hz,zeta,dt,xp)` | sequential IIR recurrence → `q(t)` `(T,)` | exact integrator; golden-vector |
| 9 | **osc** | `modal_force_projection(shape_at_impact,force_time,xp)` | `f_m(t)=φ_m(r_i)·F(t)` | scalar×vector, exact |
| 10 | **osc** | `accumulate_receiver_response(mode_q,shape_at_receivers,xp)` | `(M,T)ᵀ@(M,C)→(T,C)` modal superposition | matmul, exact |
| 11 | parity | `single_damped_oscillator_closed_form(t,amp,f_hz,zeta,phase,xp)` | `amp·e^{-ζωt}·cos(ω_d t+φ)` parity oracle | closed-form, golden-vector |
| 12 | metric | `compute_mac(s1,s2,xp)` | `\|s1ᴴs2\|²/((s1ᴴs1)(s2ᴴs2))` ∈[0,1] | exact, complex-safe |
| 13 | metric | `relative_error(true_v,est_v,xp)` | `\|t-e\|/\|t\|`; `t==0`→`\|e\|` | scalar, boundary |
| 14 | metric | `build_match_cost_matrix(known_f,det_f,known_sh,det_sh,w_f,w_s,xp)` | `w_f·Δf/f + w_s·(1−MAC)` cost `(K,D)` | pure, composes #12/#13 |
| 15 | metric | `match_modes(cost,gate,xp)` | Hungarian + gate → matched/missed/spurious | `scipy.optimize`, deterministic |
| 16 | metric | `snr_scale_noise(signal,snr_db,rng,xp)` | additive WGN at target SNR (seeded rng) | deterministic with seed |
| 17 | metric | `precision_scorecard(matched,missed,spurious,known_f,det_f,known_q,det_q,known_sh,det_sh,xp)` | per-param err + recall/precision dict | pure aggregation |

**Count: 17 delegable functions** (4 geometry + 2 pulse + **4 oscillator/iterative** +
1 parity + 6 metric). Headliners: `integrate_modal_oscillator` (#8, the exact IIR
core), `oscillator_zoh_coeffs` (#7), `accumulate_receiver_response` (#10),
`compute_mac` (#12), `match_modes` (#15), `precision_scorecard` (#17),
`rect_plate_eigenmode` (#2), `sample_shape_at_points` (#3).

**xp-agnostic discipline.** The recurrence (#8) reads force samples to host scalars and
runs the scalar IIR loop — correctness-exact and identical on numpy/CuPy (the loop is
the inherently-sequential part; the *embarrassingly-parallel* per-mode/per-receiver fan
is the non-delegated orchestration in §7.2 that calls #8 per mode and stacks via #10,
where CuPy's parallelism pays off). All other functions are vectorised over the common
numpy/CuPy API. `match_modes` (#15) is the one function with a hard SciPy dependency
(`linear_sum_assignment`, CPU-only) — its spec marks the host-transfer boundary
explicitly.

> Note `compute_mac` (#12) and `grid_point_coordinates` (#1) have close cousins in
> `mode_tracking.py` / the mapping module. Independent spec'd copies are deliberately
> kept for the **validation** side — the harness must score the estimator's MAC against
> an oracle that does NOT import the code under test (no circular dependency). The
> forward-model path may reuse canonical helpers where already pure; decided per-function
> at Phase 1.

### 7.2 NON-batch-able parts (standard Opus `/dev`)

| Part | Why not batch-able |
|------|--------------------|
| CuPy GPU forward-model orchestration (`xp`-switch; loop modes/receivers calling the delegated #7–#10; device transfer + memory mgmt) | framework/GPU-bound, stateful device mgmt; mirrors `esprit_core._to_gpu_or_cpu` |
| **Oversample → anti-alias decimate** the summed `(T_hi, C)` output from the 192 kHz internal rate down to 48 kHz (`scipy.signal.decimate`) | wraps a SciPy filter-design call; orchestration, not a pure golden-vector fn |
| Synthetic-dataset writer (writes `scenario_N.npy` + averaged_responses + metadata + `synthetic_ground_truth.json` in the Measurement layout) | filesystem IO, layout-coupling to the Measurement entity |
| Validation harness driver (call ESPRIT/tracking on the synthetic Measurement, collect results, run §5 scoring, emit report) | orchestration + IO + couples to live pipeline modules |
| REST endpoint(s) for synthesize + validate (e.g. `POST /modal/measurements/synthesize`) | Flask route, app-state, blueprint registration |
| React `SynthesizeSection.jsx`, mode table, point-selector, ECharts previews | UI/framework-bound |
| `GridLayoutEditor` select-mode extension (or new `GridPointSelector`) | React component |
| MA integration (wire section into `CollectionSubpanel`, hooks, Measurement creation) | framework + app wiring |
| ESPRIT-comparison report rendering (scorecard table, error charts, PDF parity if wanted) | UI / report generator |

---

## 8. Phased build plan

| Phase | Deliverable | Modules touched | Effort | Depends on |
|-------|-------------|-----------------|--------|------------|
| **1. Pure-fn core** (batch pipeline) | All 17 delegable functions (§7.1) with Claude-authored tests → DeepSeek bodies → green suite under `tests/unit/`. **Manifest already built + validated** (`D:\tmp\synthds-ab\manifest\`) | new `pianoid_middleware/modal_adapter/synth/` (pure helpers); `tests/unit/` | **M** (1–2 d incl. test authoring) | I/O contract (done) |
| **2. GPU sim orchestration** | CuPy `xp`-switched forward model (loops the delegated #7–#10 per mode/receiver), oversample→decimate, dataset writer → Measurement layout + `synthetic_ground_truth.json`; CPU↔GPU parity test (GPU == numpy within tol) | `synth/` (orchestrator, writer); `tests/integration/` (GPU, no audio) | **M** | Phase 1 |
| **3. Validation harness** | Driver that runs ESPRIT (+ tracking) on a synthetic Measurement and scores via §5 (#12–#17); a CLI / pytest entry that emits a scorecard | `synth/validate.py`; reuse `esprit_core`/`mode_tracking`; `tests/integration/` | **M** | Phase 2 |
| **4. Frontend Synthesize section** | `SynthesizeSection.jsx` + mode table + grid point-selector (§6.1) + ECharts previews + REST endpoint(s) + MA wiring; result/scorecard view | `PianoidTunner/src/modules/panels/collection/`, `src/components/`, `routes/` (new route), MODAL_COLLECTION + tunner docs | **L** (3+ d) | Phase 3 (needs the harness it drives) |

Rough total: ~Phase 1–3 backend ≈ 4–6 days; Phase 4 frontend ≈ 3+ days. Phases 1–3 are
independently useful (a CLI synthetic-validation tool) before any UI exists — a natural
checkpoint.

### Build-order notes

- **Phase 1 is the DeepSeek batch wave** — the whole point of the decomposition. Claude
  writes the tests (golden vectors for the closed-form functions; property tests for the
  metrics), DeepSeek fills the bodies, tests gate. No GPU, no IO → fast iteration.
- Phase 2's **CPU↔GPU parity test** is the key safety gate: the CuPy forward model must
  match the numpy reference (B13) to tolerance, so the GPU path can never silently
  diverge.
- Phase 3 reuses the **live** ESPRIT/tracking modules unchanged — proving the synthetic
  data flows through the *real* pipeline (the validation's whole value).
- Phase 4 is the only phase touching React + a new REST route; everything it needs
  already exists by Phase 3.

---

## 9. Risks & unknowns (honest)

| Risk | Severity | Mitigation |
|------|----------|------------|
| Exact `scenario_N.npy` dtype/orientation the loader expects (float32 vs 64; `(T,C)`) | Low | Measure: round-trip one array through `import_folder` in Phase 2 before trusting it (§2.6 note). Not a doc gap, just a confirm-step. |
| Mode-shape **sign/phase**: synthetic shapes are real; ESPRIT returns complex. Comparison must be scale/phase-invariant | Low | MAC (B15) is already complex-scale-invariant by construction. |
| `Q = 1/(2 zeta)` light-damping approximation breaks for very high damping (`zeta` near 1) | Low | Pipeline discards `damping > 0.2` anyway (Max Damping default); stay in the lightly-damped regime where the relation is exact enough; document the assumption. |
| TF pressure: user prefers TF but env reality favours CuPy | Medium (decision) | §4 recommends CuPy + numpy; flag TF as a deliberate later add-on via the `xp`-switch. **User decision point.** |
| Band config must cover the synthetic modes' frequencies or ESPRIT won't find them (a config artifact, not an estimator failure) | Medium | Author ground-truth sets whose frequencies sit inside the chosen band preset; the scorecard's "recall" surfaces band-coverage gaps explicitly. |
| Reusing `compute_mac`/grid helpers vs re-implementing for the validation side (circular dep on code-under-test) | Low | §7.1 note: independent spec'd copies for the validation metric; reuse canonical ones in the forward model. |
| `GridLayoutEditor` is under "Band Configuration"/locked-settings rules in its current home | Low | The Synthesize use is a *new* context (pre-acquisition), not gated by ESPRIT-run locks; use select-mode variant (§6.1 option a/b). |

---

## 10. Design questions — ALL RESOLVED (signed off 2026-06-06)

1. **GPU backend** → **CuPy + numpy CPU fallback** (NOT TensorFlow). Signed off.
2. **Mode-shape input priority** → **analytic plate-eigenmodes core first**, then
   image-import, then draw. Signed off. (`rect_plate_eigenmode` #2 is the day-one path;
   `image_to_shape_grid` #4 ships alongside but image-import UI is secondary.)
3. **Validation surface** → **inline scorecard** in the Synthesize section. Signed off.
4. **Grid reuse** → **extend `GridLayoutEditor`** with a select-mode (§6.1a, one
   component). Signed off.
5. **Pass thresholds** → **as recommended** (median freq err < 1 %, median MAC > 0.95,
   recall > 0.9). Signed off.

**Plus 2 directives applied:** (1) physics refined to the iterative force-driven model
(§3.4); (2) the A/B delegation manifest built + validated (§7.1, §12).

---

## 11. Investigation history & evidence

- **No existing 2-D soundboard forward model** in the repo: the synthesis engine models
  1-D strings (FDTD) + per-string harmonic-oscillator modes
  ([`pianoid-cuda/SYNTHESIS_ENGINE.md`](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md)),
  which is a different physical object from a 2-D plate with spatial `phi(x,y)`. Source
  survey (grep `soundboard`/`plate mode`/`synthetic`/`ground-truth` across `docs/` and
  the modal_adapter source) found only ESPRIT-side references and the FEA-comparison
  presentation slides — no in-repo synthetic generator. → this feature is genuinely new.
- **I/O contract fully documented** (rare): input `(T, n_channels)`, signal model
  (damped sinusoids), output schema, MAC definition — all explicit (§2). The only
  confirm-by-measurement item is the on-disk npy dtype/orientation (§9).
- **Env probed** 2026-06-06: CuPy 14.0.1 / CUDA 12.9 present; TensorFlow absent (§4).
- **Grid tool read** in full: `GridLayoutEditor.jsx` is controlled/presentation-only,
  produces `gridShape`/`cellMask`/`pointCoordinates` — directly reusable (§6.1).

### Source references

| Topic | Doc / file |
|-------|-----------|
| ESPRIT I/O + signal model | [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../guides/MODAL_ADAPTER_GUIDE.md) § Algorithm Overview, § Data Formats, § Preset Conversion |
| ESPRIT module structure | [`docs/modules/pianoid-middleware/OVERVIEW.md`](../modules/pianoid-middleware/OVERVIEW.md) (`esprit_core`, `band_merging`, `mode_tracking`) |
| Tracking + MAC | [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../guides/MODAL_ADAPTER_GUIDE.md) § Tracking Section; [`MODE_TRACKING_REDESIGN.md`](../development/archive/MODE_TRACKING_REDESIGN.md) (`compute_mac`) |
| Measurement entity + import | [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../modules/pianoid-middleware/MODAL_COLLECTION.md) |
| Collect subpanel + grid tool | [`docs/modules/pianoid-tunner/OVERVIEW.md`](../modules/pianoid-tunner/OVERVIEW.md) § CollectionSubpanel; `PianoidTunner/src/components/GridLayoutEditor.jsx` |
| REST surface | [`docs/modules/pianoid-middleware/REST_API.md`](../modules/pianoid-middleware/REST_API.md) (`/run_esprit`, `/run_tracking`, `/measurements/import_folder`) |

---

*Design only. No code written, no build run, no servers started. The one repo write is
this proposal. Awaiting user review + answers to §10 before any implementation.*
