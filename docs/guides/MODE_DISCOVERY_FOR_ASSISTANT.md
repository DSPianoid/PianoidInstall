# Mode Discovery Guide (soundboard measurement, for the assistant)

**Audience:** the in-UI Pianoid assistant (and anyone who needs the measurement procedure in one place). **Owner:**
dev-modeguide, 2026-10-19. Everything below is distilled from the measurement reports and logs listed in
[Sources](#sources); each section names its source. Where the sources do not support a claim, it is marked
**UNKNOWN**. Do not fill those in: say so and offer the measurement that would settle it.

Read this page with `read_docs` (page `guides/MODE_DISCOVERY_FOR_ASSISTANT.md`) and the anchor that fits:
`can-do`, `rig`, `ladder` (or a step: `step-0` … `step-11`), `recipes`, `decisions`, `known`, `open`, `gaps`,
`data-layout`.

## What the assistant can and cannot do here {#can-do}

The measurement work of 2026-10-11 … 10-17 was done by **agents running scripts** against the ASIO measurement
session (`POST /audio/session`). That session is **not** in the command registry (`audio.devices` says so), and
the assistant has no shell and no file access. So most of the ladder is **"hand to the user / an agent"**. The
assistant's own part is: read the state, check the setup, explain the procedure and its acceptance criteria,
load and verify the measured preset, analyse offline renders, and play (with confirmation) on the board.

| The assistant can (registry name) | Category |
|---|---|
| `system.snapshot`, `system.environment` (incl. the output map), `system.health` (peaks, clipping), `audio.devices` (ASIO in / out list), `calibration.mic_devices` (ASIO inputs + the selected capture input) | read, no confirm |
| `preset.files`, `preset.summary`, `preset.load_settings`, `param.get` (modes, deck rows, masks), `param.inventory` | read, no confirm |
| `preset.load` (load at the declared settings), `modal.run_stage`, `modal.apply_to_preset`, `calibration.synthesis`, `calibration.attack_equalize`, `launcher.modal.start` | **hard confirm, every time** |
| `render.note_playback`, `render.chart`, `render.keyboard` (offline; `export: true` makes an artefact) | renders (asks while live audio plays) |
| `play.note`, `play.mode`, `play.reset` (live: the sound goes to the exciters on the board) | playback |
| `param.mute_modes`, `param.mute_channels`, `param.set` | params (Ask unless Auto, inside the safety envelope) |
| `analysis.run_python` on artefacts from renders / `param.get` / `preset.summary` | asks every run |
| `job.get`, `job.list`, `job.cancel`, `modal.status`, `modal.cancel`, `calibration.status`, `calibration.cancel` | read / act |

| The assistant cannot | Why |
|---|---|
| Drive a sweep, multisine, stepped sine or stop-and-decay on the rig, or record the piezos | `/audio/session` is not exposed; no command plays a test signal on chosen outputs and records chosen inputs |
| Read the recordings in `D:\modal_measurements\` | no file access; `analysis.run_python` takes only artefact ids (renders, `param.get`, `preset.summary`) |
| Run PolyMAX, the consensus fit, LSFD, the appropriation planner or the preset builder | they are Python CLIs / scripts (see each step) |
| Set `PIANOID_AUDIO_OUTPUT_MAP` | it is an environment variable of the backend process; the user restarts the backend with it |
| See the wiring (which exciter / piezo is on which jack) | ask the user; the last documented wiring is in [Rig facts](#rig) |

**Safety (applies to every live step).** Rig audio drives seven exciters on a real board. Always say in one line
what will play, on which outputs, how loud and how long, and get the user's yes. Never play loud or long audio
unprompted. The documented working levels are in [Rig facts → levels](#rig-levels); the playback ceiling used on
10-15 was per-output peaks ≤ −30 dBFS (measured ≤ −31 dBFS), with E2 at −6 dB. Read `system.health`
(`peak_level_now`, `clipping_now`) after any live step.

## Rig facts {#rig}

Source: [report 10-14 §1, §3, §5](../development/report-mode-discovery-2026-10-14.md), the dev-fd69 session log
(`development/logs/dev-fd69-2026-10-11-165927.md`, 10-14 evening … 10-15), [measured preset §2, §6,
§10b](../development/measured-plywood-preset-2026-10-15.md), [AUDIO_DRIVERS → ASIOAudioDriver and Rig
facts](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver).

### Board, interface, transducers {#rig-board}

| Fact | Value | Source |
|---|---|---|
| Board | 8 mm plywood, about 1200 × 1000 mm (no bridge, no strings). Mass used for the preset: 650 kg/m³ → M = 6.24 kg | measured preset §2, §5.2 |
| Interface | Behringer UMC1820, `UMC ASIO Driver`; 18 in / 20 out (`In 1`–`In 8`, `Out 1`–`Out 10`, SPDIF, ADAT); every channel Int32LSB; the engine opens it at 48 kHz, buffer 64 | AUDIO_DRIVERS rig facts |
| Round trip | loopback onset 334–335 frames (reported 304 + about 30 frames converter delay); constant within one backend run, it can shift between backend instances (E7 → P8 IR peak 39 → 46 samples on 10-15) | AUDIO_DRIVERS; fd69 log 10-15 |
| Exciters | E1–E7, inertial voice-coil exciters on the board | report 10-14 §1 |
| Piezos | P1–P8 (P8 collocated with E7 = the driving point). Positions: `layout-20261014/board_layout.json` (from a photo, ±30 mm, up to ±50 mm at the edges) | report 10-14 §1 |
| Weights | Since 10-15 **masses are attached to the exciters** (not to the board). Moving mass about ×1.6 (median) | fd69 log 10-15 |
| Out 1 / Out 2 | pass through the UMC MAIN knob (about 13 dB quieter): monitor outputs, not used for the exciters | report 10-14 §3 |

### Output map (engine channel → exciter) {#rig-output-map}

Since 10-14 evening: **E1 → Out 9, E2 → Out 10, E3..E7 → Out 3..7**. The measured preset's channels 0..6 = E1..E7
(output pitches 128..134). The engine plays channel k on ASIO output `map[k]` (0-based), so the backend must run
with **`PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6`** (ASIO callback driver only; unset = identity, which would send
E1 / E2 to the monitor outputs 1 / 2). Check it with `system.environment` (`output_map`). If it is missing, the
user restarts the backend with the variable set; the assistant cannot set it.

### Inputs (which jack carries what) {#rig-inputs}

The input wiring changed between sessions. The last documented states:

| Session | In 1–7 | In 8 | Reference |
|---|---|---|---|
| 10-14 morning | P1–P7 | P8, later loopback Out 8 → In 8 | loopback |
| 10-14 evening, 10-15 morning | coil currents of E1–E7 | P8 at E7 | the coil currents |
| 10-15 afternoon (FRFs used for the preset) | P1–P7 (10-14 positions confirmed) | P8 | none (no loopback) |
| now | **UNKNOWN**: ask the user | | |

The mic capture input (`play.keyboard capture_mic`, acoustic calibration) records ONE physical input, selected in
Calibration Settings; `calibration.mic_devices` shows the ASIO inputs and the selected `input_channel` (0 = In 1).
On 10-15 the live playback check measured on piezo P1 = In 1.

### Exciter resonances {#rig-resonances}

Coil-admittance minimum (suspension resonance fs), Hz. Below fs the drive force falls (a 14 dB shelf below about
31 Hz, 10-14).

| | E1 | E2 | E3 | E4 | E5 | E6 | E7 |
|---|---|---|---|---|---|---|---|
| 10-14 (no weights) | 37.8 | 31.8 | 34.8 | 37.6 | 40.6 | 37.0 | 45.0 |
| 10-15 (weights on) | 28.0 | 27.1 | 32.6 | 30.0 | 28.6 | 30.5 | 34.9 |

The admittance above 60 Hz did not change with the weights (≤ 0.26 dB). It is flat over 60–1000 Hz within 0.1 dB
per exciter; relative levels E1 +4.7, E2 +4.5, E3 +0.3, E4 −4.5, E5 −3.5, E6 −0.8, E7 −0.7 dB re the mean
(measured preset §6). Per volt the exciters differ (Out 3 about +9 dB, 10-14); per ampere removes most of it.

### Distortion: E1 / E2 {#rig-distortion}

- **E2 distorts mechanically**: motion 2nd harmonic at P8 −16 to −20 dB at −36 dBFS, 24 dB above its own coil
  current. **E1** is next (about −37 dB). The coil currents are clean (H2 −50 to −58 dB), so the amplifiers and the
  UMC are fine (B3, 10-14).
- Decision 10-14: **E2 runs 6 dB lower** (−48 dBFS in sweeps; E2 deck row × 0.5 in the 10-15 live playback) until
  its mounting is inspected. Inspection result: **UNKNOWN** (planned by the user for 10-15; no source records it).
- Earlier (10-12, 4-exciter setup): the exciter then on Out 3 had H2 −29.5 / −22.9 / −16.8 dB at −36 / −30 / −24
  dBFS; keep it ≤ −30 dBFS. ESS / chirp deconvolution removes harmonics from the linear FRF; an impulse train
  cannot.

### Current-sense crosstalk caveat {#rig-crosstalk}

- The current-sense harness on In 1–4 has a **shared return**: a fixed −42 … −45 dB coupling at about 180° between
  every pair. The P8 cable couples into In 5–7 at −41 … −44 dB. Separating the wires on 10-15 changed nothing (a
  common-impedance ground path).
- Consequence: **coil currents are valid as force references (the diagonal), not as extra response sensors.**
  Broadband reciprocity fails for most pairs. Fix (not done): separate returns / shielded pairs, re-route the P8
  cable.

### Levels and guards {#rig-levels}

| Item | Value |
|---|---|
| Sweep levels per exciter (10-14 / 10-15) | E1 −42, E2 −48 (was −42), E3 −36, E4 −30, E5 −36, E6 −42, E7 −36 dBFS |
| Input guards in the scripts | an input above −6 dBFS steps the level down; above −3 dBFS stops |
| Live dwell / appropriation (10-15) | largest output −36 dBFS (E2 −42) |
| Live playback of the measured preset (10-15) | per-output peaks −31 … −35 dBFS at volume 95, ceiling −30 dBFS, E2 −6 dB |
| Linearity | small level dependence: about 1 dB per 12 dB below 250 Hz, frequencies within 0.15 %; superposition holds above 35 Hz (all 7 at once = one at a time within 0.4–0.6 dB) |
| Drift | about 0.13 % in frequency and 0.4–0.6 dB at LF over 1.7 h |
| Disk | keep ≥ 5 GB free on D: (a full disk aborted a run on 10-14); a full 7 × 7 is 0.7–0.8 GB |

## The procedure ladder {#ladder}

Each step: purpose, the command (or the hand-off), parameters, expected output, acceptance, pitfalls, safety.
Timing comes from [report 10-14 §7](../development/report-mode-discovery-2026-10-14.md). The minimum trustworthy
session below 200 Hz is about 45 min (3 × full 7 × 7 + consensus); the minimum useful one about 20 min.

Scripts named below live in `docs/development/diagnostics/` (dev-fd69 / dev-a709 / dev-b8e3) and
`D:\modal_measurements\rig_checks\*.py`. The modal-adapter packages they import (`polymax`, `swept_discovery`,
`appropriation`, `measurement`) are on the **unmerged** Core branch `feature/dev-fd69-modal-methods` (worktree
`D:\repos\wt-fd69-core`); see [Branch status](#branch-status).

### Step 0: state and preconditions {#step-0}

- **Purpose:** know what runs and how the rig is wired before anything plays.
- **Commands:** `system.snapshot` (backend, driver, environment, output map, active preset), `audio.devices`
  (ASIO device, inputs / outputs), `calibration.mic_devices`, `preset.load_settings`.
- **Expected:** ASIO callback driver active with no fallback; `output_map` = `8,9,2,3,4,5,6` for the measured
  preset; the UMC with In 1–8 and Out 1–10.
- **Ask the user:** what is on In 1–8 today (piezos or coil currents), whether the weights are on, whether E2 was
  inspected, and whether D: has ≥ 5 GB free (the assistant cannot see the disk).
- **Pitfall:** a healthy-looking `/health` does not prove the interface is present (the rig dropped out before);
  `audio.devices` lists the device the engine actually opened.

### Step 1: wiring / ID check {#step-1}

- **Purpose:** prove each output drives the exciter you think, and each input carries its own sensor.
- **Hand to the user / agent:** passive noise record (silence 5–10 s, all inputs), then ID bursts (1 s chirp
  100 Hz–2 kHz per exciter, 3 s apart, −42 dBFS). Scripts: `dev-fd69-exciter-id-bursts-2026-10-14.py`,
  `rig_checks\wiring_capture.py` + `wiring_analyse.py`. About 1 min.
- **Acceptance:** with coil currents on the inputs, In k answers only Ek (own current +30 … +39 dB, crosstalk 24–33
  dB down); with piezos, every exciter reaches the board; the E7 → P8 IR peak is at a stable sample within the
  session; the passive record shows the floor plus 50 Hz hum only.
- **Pitfalls seen:** a silent exciter (E3 on 10-15), E6 dropping out (10-14) or weak (10-15), a weak piezo on In 5
  (10-13), unequal input gains (up to 20 dB, 10-13): equalise the gains and probe first.
- **Safety:** short, quiet bursts; still confirm.

### Step 2: driving point and exciter admittance {#step-2}

- **Purpose:** each exciter's fs and admittance (needed for per-ampere data and to tell exciter resonances from
  board modes).
- **Hand to the user / agent:** "B2": 20 s ESS 15–200 Hz × 2 per exciter, coil currents recorded (5.7 min).
  Scripts: `dev-fd69-current-ref-b2b4-2026-10-14.py`; driving point: `rig_checks\drivingpoint_capture.py` +
  `drivingpoint_analyse.py`.
- **Expected:** the fs table above; admittance flat above 60 Hz.
- **Pitfall:** per ampere is not per newton near fs (inertial exciters). There is no force calibration and no
  calibrated accelerometer, so all scales are relative.

### Step 3: linearity and distortion ladder {#step-3}

- **Purpose:** choose safe levels; find a distorting exciter.
- **Hand to the user / agent:** 8 s ESS 20 Hz–10 kHz (+ 3–4 tones) at 3–5 levels per exciter (3–6 min).
  Scripts: `dev-fd69-nonlin-exciters-2026-10-14.py`; current vs motion: B3 in `dev-fd69-current-ref-b2b4-2026-10-14.py`.
- **Acceptance:** the linear FRF scales within 0.5 dB per +6 dB; H2 of motion vs the coil current tells mechanical
  from electrical distortion.
- **Decision rule:** an exciter whose motion H2 is well above its current H2 is mechanical (mounting): lower its
  level (E2 −6 dB) and ask the user to inspect it.

### Step 4: multi-exciter excitation (the FRF matrix) {#step-4}

- **Purpose:** the 8 × 7 (sensors × exciters) FRF matrix that every extraction uses.
- **Hand to the user / agent:** full 7 × 7 ESS: 20 s ESS 20 Hz–2 kHz (+ 3 s tail), **3 repeats per exciter**, 21
  sessions, 8.8 min, at the [sweep levels](#rig-levels). Optional: MIMO orthogonal multisines (all 7 at once,
  20 Hz–2 kHz, 4.3 min) for fast surveys **above 35 Hz**; a dedicated LF ESS 15–150 Hz (30 s) below 35 Hz.
  Scripts: `dev-fd69-fixed-layout-2026-10-14.py`, `dev-fd69-lf-identification-2026-10-14.py`,
  `dev-fd69-mimo-2026-10-14.py`; swept discovery CLI `python -m pianoid_middleware.modal_adapter.swept_discovery run`.
- **Acceptance:** 0 xruns; peaks below the guards; repeat coherence high (10-12: γ² ≥ 0.9996, 42–48 dB repeat SNR).
- **Pitfalls:** below 30 Hz the 7-exciter multisine and the sweep differ by 10–20 dB (unresolved, not per-exciter
  stick-slip): use the sweep there. Per-volt data favour the hot outputs (Out 9 / 10): use per-ampere data
  (each exciter's measured admittance) and drive at **equal coil-current RMS**.
- **Safety:** about 9 min of sweeps on 7 exciters: confirm the plan and levels with the user first.

### Step 5: mode extraction {#step-5}

- **Purpose:** poles (f, ζ) and residues from the FRF matrix.
- **Method ranking on this board** ([report 10-12 §4, §6.1](../development/report-mode-discovery-2026-10-12.md)):
  1. **PolyMAX** (multi-reference pLSCF + LSFD): primary f, ζ and shapes up to about 1.1 kHz; its ζ matches the
     model-free decays (ratio 1.01). CLI `python -m pianoid_middleware.modal_adapter.polymax` (fd69 branch).
  2. **Consensus below 200 Hz:** single PolyMAX fits there are unreliable (the same data gave different lists).
     Run **18 fits per run** (3 band sets × 2 orders × 3 bootstrap) over ≥ 3 runs and keep the poles that recur.
     Script `dev-fd69-consensus-lt200-2026-10-14.py` (190 s per run).
  3. **Swept joint fit** (dev-69fd): independent cross-check of f and shapes; its ζ reads about 30 % high.
  4. **Per-exciter ESPRIT: do not use on this board** (impulse or chirp IRs). Cross-exciter agreement is at
     chance level; ζ reads low (down to 0.1–0.2 %).
- **About `modal.run_stage`:** it runs the modal adapter's **ESPRIT** pipeline (load → mapping → ESPRIT →
  tracking → feedin) over a modal-adapter Measurement / project. That is method 4 above, so it is the wrong tool
  for this plywood board. Use it only for the piano-measurement projects it was built for, and only with the
  user's confirmation.
- **Acceptance:** frequencies repeat to about **0.3 %** across runs, ζ to about **0.2 pp**; leave-one-exciter-out
  matches far above chance (10-11: 41–46 modes vs 12–16 by chance); for shapes, repeat MAC ≥ 0.9.
- **Pitfalls:**
  - **Overlap below about 500 Hz:** modal overlap factor median 1.9 below 200 Hz; single-mode methods (peak
    picking, half-power, single-reference fits) mix neighbours. Use PolyMAX, which fits neighbours jointly.
  - **50 Hz hum:** PolyMAX returns a pole pair at 49.9 / 50.1 Hz with ζ 0.36–0.38 %: mains, not a mode. Exclude
    50 Hz and its harmonics (the 49.69 Hz mode of 10-15 was dropped as mains-adjacent).
  - **1–2 kHz:** no usable model (only 1–3 stable poles; about 60–100 modes there that 7 points cannot resolve).
    Above 2 kHz no pole is MPF-stable.
  - The 35–60 Hz region: the 36–39 Hz peaks were the exciters' own resonances (10-14); see [32.5 Hz](#d-32hz).

### Step 6: damping validation (Q) {#step-6}

- **Purpose:** trust the ζ that goes into the preset.
- **Hand to the user / agent:** Q confidence (analysis only): `dev-fd69-q-confidence-2026-10-15.py` (PolyMAX per
  run, settings spread, enhanced-FRF half-power / SDOF, free decays). Focused stop-and-decay (live):
  `dev-fd69-q-decay-2026-10-15.py`: per mode a ±1.5 % tuning sweep (7 dwells), then 3 × (steady drive with the
  mode or optimum vector → 5 ms stop → decay ≥ max(1 s, 12 τ)), max −36 dBFS (E2 −42). 24 modes, 48 sessions.
- **Acceptance:** decays repeat (sd ≤ 0.08 pp); a decay is clean when the log-envelope residual is < 0.8 dB, the
  decay frequency stays within 1 % of the target, and the gap covers ≥ 3 τ.
- **Which ζ to use** (applied in the measured preset, §4.3): tight decay class → the decay value; beating or
  overlapped modes → PolyMAX, with the decay as an **upper bound**; enhanced-FRF half-power / SDOF are upper
  bounds only (median × 1.5, up to × 4 at overlapped modes).
- **Pitfalls:** below about 500 Hz most decays beat with neighbours (ζ 20–170 % above PolyMAX). All measured ζ
  include the electrical damping of the attached exciters (shorted coils, estimated +2 … 8 %); the preset models
  the board as it is (no correction).

### Step 7: mode shapes {#step-7}

- **Purpose:** the response shape u (over the piezos) and the drive vector v (over the exciters) per mode.
- **Hand to the user / agent:** LSFD with the fixed pole list: `dev-fd69-mode-shapes-appropriation-2026-10-15.py`
  (output `mode-shapes-20261015\mode_shapes.json`), board-mm plots `dev-fd69-replot-shapes-mm-2026-10-14.py`.
- **Expected per mode:** u, v, rank-1 share, cross-exciter MAC, repeat MAC; reliability class.
- **Pitfalls:** shapes repeat run to run (MAC 0.95) but different exciters see different shapes (about 0.3): the
  modes overlap and 7 sensors cannot separate them. That is the main limit, not noise. **Shapes are not
  comparable across days** (the piezos never sat in the same place twice); frequencies and damping are.

### Step 8: appropriation (drive each mode with its own vector) {#step-8}

- **Purpose:** check that driving the exciters in proportion to a mode's drive vector excites that mode; this
  vector becomes the preset's channel weights.
- **Hand to the user / agent:** `dev-fd69-appropriation-live-2026-10-15.py` (plan from 3 FRF runs; stepped sine at
  f_m, 2 s settle + 1 s lock-in; vectors: mode, optimum = top singular vector of H_I(f_m), best single, uniform,
  3 random), at **equal coil-current RMS**, max −36 dBFS (E2 −42). CLI `python -m
  pianoid_middleware.modal_adapter.appropriation` (fd69 branch).
- **Acceptance (10-15, 24 modes):** the mode vector beats single / uniform / random in every mode; median −0.3 dB
  on the target mode and −0.6 dB on the total response vs the optimum; live − predicted about 0 dB median (max
  2.3 dB at 220 Hz).
- **Pitfall:** the optimum maximises total response, so where modes overlap it also drives the neighbours; real
  signed weights (decka form) are as good as complex ones on this board.

### Step 9: build the measured preset {#step-9}

- **Purpose:** replace the base preset's low modes with the measured ones. Done twice:
  `F15_measured_plywood_2026-10-15` and, with the user's decisions, **`F15_measured_plywood_2026-10-17`** (the
  current one; the 10-15 file stays for A/B).
- **Hand to an agent** (no command): [measured preset §13 and §14.6](../development/measured-plywood-preset-2026-10-15.md#146-reproduce-10-17):
  `dev-a709-measured-modes-2026-10-15.py` (residues per ampere) → `dev-a709-measured-table-2026-10-15.py
  --boundary-hz 1020 --zeta-average 220.07` → `python -m Pianoid.measured_mode_preset BASE MEASURED --out OUT` →
  `dev-b8e3-carry-hf-weights-2026-10-17.py` → `dev-a709-equalize-preset-2026-10-15.py --write` →
  `dev-a709-verify-preset-2026-10-15.py --write-layer-b`. All offline, in a separate process, audio off.
- **The rules it applies** (so the assistant can explain them):

| Topic | Rule (10-17) |
|---|---|
| Base | `F15_Elyashev_array512.json`, unchanged; 196 shaped modes on the legacy full-deck path (`num_modes + num_channels ≤ num_strings`: 196 + 7 ≤ 236) |
| Boundary | **1020 Hz**: 39 measured modes below (66.58 … 1010.38 Hz); F15 modes from 1043.68 Hz up verbatim; 16 FPGA fill modes (two capped at k = 0.1) |
| Selection | the live-validated core modes, plus every mode with repeat MAC ≥ 0.9; dropped: repeat MAC < 0.9, the 49.69 Hz mains-adjacent mode, 32.7 Hz (not pursued) |
| Frequency | stored with `gpu_mode_frequency(f) = (sr/π)·sin(πf/sr)` so the engine plays f exactly |
| Damping | ζ → `decrement`: γ = ζ·2π·f/√(1−ζ²), dec = 1 − e^(−γ/sr), decrement = dec·sr/f_field; ζ choice as in [step 6](#step-6); **220.07 Hz = mean of PolyMAX 0.830 % and decay 1.925 % = 1.3775 %** |
| Mass | relative 1/m ∝ σ1·max\|u\|·max\|v\|; the f^2.15 instrument trend removed; per-mode residual clipped to ±6 dB; anchored to the geometric-mean `mass_inv` of the 14 F15 modes in 1000–1500 Hz (5.29e-13). Measured `mass_inv` 2.65e-13 … 1.06e-12 (normal, not an error) |
| Channels | 7 channels = E1..E7 (output pitches 128..134, the feedback row holds the per-mode weights); measured modes: `v_current` made real (rotate by the largest entry's phase, real part, max \|·\| = 1); modes above the boundary: equal magnitude 0.527 with random signs (seed 0), carried over from 10-15; common scale max \|weight\| = 430; no voltage trims |
| Couplings | placeholder: each measured mode inherits the nearest F15 deck column (median 18 c); this board has no bridge |
| Equalization | keyboard RMS spread 32.5 → 0.0013 dB (full hammer-mass range accepted, 60 keys below 2 g) |
| Level (Layer B) | worst chord oct_chain_C_8 +20.1 dB → target p60 −26.11 dBFS; `output_scale` 4.546e15 |

- **About the equalization commands:** `calibration.synthesis` is the same equalizer
  (`CalibrationController.calibrate_synthesis`) but it runs inside the backend, and the policy refuses a
  calibration render while live audio plays. The Layer B recalibration (`--write-layer-b`) has **no command**. For
  this preset, hand the equalization to an agent with the offline harness above.
- **Do not use `modal.apply_to_preset` for this:** it injects ESPRIT-tracked chains from a modal-adapter project,
  not the measured table.

### Step 10: load at the DECLARED settings {#step-10}

- **Purpose:** play the measured preset with the settings it was built and calibrated for.
- **Commands:** `preset.files` (find `F15_measured_plywood_2026-10-17.json` and its `load_path`), then
  `preset.load {path}` (hard confirm). Then `preset.load_settings`: if `mismatches` is not empty, reload with the
  **declared** values (`preset.load` with those settings). Never guess settings from the name.
- **Declared settings (measured preset §1, §14.5):** `array_size 512`, `string_iterations 16`, 48 kHz, 64
  samples per cycle, `listen_to_modes 0` (strings axis), `sound_derivative_order 1`. Driver: ASIO callback with
  the [output map](#rig-output-map).
- **Verify:** `preset.summary` → `num_modes 196`, `num_channels 7`, `num_strings 236`; `system.health` →
  `output_scale` not stale; `system.environment` → `output_map` `8,9,2,3,4,5,6`. One offline render of p60
  (`render.note_playback`) must not be `all_zero`. Raw peaks of this preset are about 1e-8 (its `output_scale` is
  large): that is not silence.
- **Pitfalls:** a load with other settings leaves a stale `output_scale` (level off by orders of magnitude); this
  preset cannot be D2D-switched from a 4-channel layout (236 strings → full reload).

### Step 11: check on the board (optional, live) {#step-11}

- **Purpose:** hear and see that every exciter is driven and nothing clips.
- **Commands:** `param.mute_channels {channels: [k], action: solo}` per channel, `play.note` (for example p69,
  moderate velocity, short), read `system.health` (`peak_level_now`, `clipping_now`) after each; then
  `param.mute_channels {channels: all, action: unmute}`. A single mode: `play.mode {mode_no}` (modes 0..38 are the
  measured ones).
- **Acceptance (10-15):** every channel drives the board; per-output peaks ≤ −31 dBFS at volume 95; no clipping.
- **Safety:** confirm each burst; keep E2 in mind (−6 dB was used live on 10-15; whether it is still needed is
  UNKNOWN until the inspection result is known). The acoustic judgement (rattle, balance) is the user's: the
  assistant has no listening microphone on the board unless the user selected one.

## Analysis recipes (`analysis.run_python`) {#recipes}

The sandbox has numpy / scipy / soundfile / matplotlib, no network, no Pianoid access and no files except its
inputs. Inputs are **artefact ids**: make them with `export: true` on `render.note_playback`, `render.chart`,
`render.keyboard`, `param.get` or `preset.summary`. In the code: `ARTIFACTS[id]` (the meta),
`artifact_path(id)` (the first file; `artifact_path(id, 'series_0.npy')` for another), and `OUT` for PNG / CSV /
JSON outputs. Never paste samples into the code. Rig recordings cannot be inputs (see [Gaps](#gaps)), so these
recipes work on **offline renders and preset data**. Renders are raw engine units: compare renders of the same
preset, report frequencies, ratios and dB differences.

### R1: which measured modes show up in a note {#r1}

Render p100 v127 (its string partials are all ≥ 2.6 kHz, so peaks below 1 kHz are modes), export, then:

```python
import json, numpy as np, soundfile as sf
from scipy.signal import find_peaks
aid = list(ARTIFACTS)[0]
x, sr = sf.read(artifact_path(aid), always_2d=True)          # frames x channels
x = x.sum(axis=1)                                              # all output channels
n = len(x); w = np.hanning(n)
X = np.abs(np.fft.rfft(x * w)); f = np.fft.rfftfreq(n, 1 / sr)
band = (f > 40) & (f < 1050)
db = 20 * np.log10(X[band] / X[band].max() + 1e-20); fb = f[band]
pk, _ = find_peaks(db, prominence=6, height=-40)          # within 40 dB of the top peak
top = pk[np.argsort(db[pk])[::-1][:23]]
measured = [66.58, 94.78, 133.19, 140.28, 174.48, 189.01, 198.78, 220.07, 232.13, 277.05, 316.95, 341.40,
            354.94, 383.64, 419.08, 432.42, 475.76, 493.87, 504.94, 542.66, 546.50, 567.65, 583.74, 599.23,
            617.88, 637.72, 650.09, 671.73, 693.63, 715.54, 751.39, 796.51, 820.53, 835.78, 875.81, 900.96,
            921.12, 979.11, 1010.38]
rows = []
for i in sorted(top, key=lambda i: fb[i]):
    m = min(measured, key=lambda g: abs(np.log2(fb[i] / g)))
    rows.append((round(fb[i], 2), m, round(1200 * np.log2(fb[i] / m), 1), round(db[i], 1)))
print(json.dumps(rows))
```

Expected on the 10-15 preset: all 23 strongest peaks within 25 c of a measured mode, 21 within 2.1 c (resolution
permitting: use a long `display_length_ms`, for example 3000 ms, for a fine bin).

### R2: f and ζ of one mode from a free ring {#r2}

Solo the mode on the key (`param.mute_modes {modes: [n], pitches: [100], side: both, action: solo}`, an undoable
edit, asks), render p100 with `export: true`, then undo the mute (`history.undo`). Band-pass around the mode and
fit the envelope:

```python
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfiltfilt
from scipy.optimize import curve_fit
aid = list(ARTIFACTS)[0]; f0 = 220.07                        # the mode under test
x, sr = sf.read(artifact_path(aid), always_2d=True); x = x.sum(axis=1)
y = sosfiltfilt(butter(2, [f0 * 0.9, f0 * 1.1], btype='band', fs=sr, output='sos'), x)
i0 = int(np.argmax(np.abs(y))) + int(0.05 * sr)               # skip the attack
seg = y[i0:i0 + int(0.4 * sr)]; t = np.arange(len(seg)) / sr
spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 16 * len(seg)))
f_init = np.fft.rfftfreq(16 * len(seg), 1 / sr)[np.argmax(spec)]
model = lambda t, a, g, f, p: a * np.exp(-g * t) * np.sin(2 * np.pi * f * t + p)
best = None
for p0 in np.linspace(0, 2 * np.pi, 8, endpoint=False):     # a few start phases
    try:
        prm, _ = curve_fit(model, t, seg, p0=[np.abs(seg).max(), 10.0, f_init, p0], maxfev=20000)
    except RuntimeError:
        continue
    r = np.sum((model(t, *prm) - seg) ** 2)
    if best is None or r < best[0]:
        best = (r, prm)
r, (a, gamma, fd, p) = best
zeta = gamma / np.sqrt((2 * np.pi * fd) ** 2 + gamma ** 2)
print(f"f_d {fd:.3f} Hz  zeta {100 * zeta:.3f} %  tau {1e3 / gamma:.1f} ms  "
      f"rel. residual {np.sqrt(r / np.sum(seg ** 2)):.3f}")
```

Reference: the 10-17 verification (its own probe: each measured mode excited alone, free ring 400 ms) found every
measured mode within 0.16 c and ζ within 0.78 % (relative) of the table; this recipe is coarser. A relative
residual above about 0.1 means a beating neighbour or a second component in the band: narrow the band, or say the
value is a mixture. (A Hilbert-envelope fit is biased here: the analytic signal of an abruptly starting decay has
a slowly decaying tail; tested on a synthetic ring, it read 215 Hz for 220.07 Hz.)

### R3: ζ from the stored mode parameters (no render) {#r3}

`param.get {parameter: mode, key_no: all, export: true}`, then convert with the laws of [step 9](#step-9):

```python
import json, numpy as np
aid = list(ARTIFACTS)[0]; sr = 48000.0
res = json.load(open(artifact_path(aid), encoding='utf-8'))
print(type(res), list(res)[:5] if isinstance(res, dict) else len(res))   # inspect the shape first
def played_hz(freq_field):
    w = (2 * np.pi * freq_field / sr) ** 2                     # small-angle parameter
    return np.arccos(1 - w / 2) * sr / (2 * np.pi)              # the frequency the mode plays
def zeta_of(freq_field, decrement):
    dec = decrement * freq_field / sr                          # per-sample amplitude loss (1 - dec per sample)
    gamma = -np.log(1 - dec) * sr                              # decay rate, 1/s
    wd = 2 * np.pi * played_hz(freq_field)
    return gamma / np.sqrt(wd ** 2 + gamma ** 2)
# check against the table: mode 7 (220.07 Hz, decrement 0.086545) gives about 1.3775 %
```

Adapt the parsing to the printed shape (the result is per mode: `frequency`, `decrement`, `mass_inv`). The stored
field is `gpu_mode_frequency(f) = (sr/π)·sin(πf/sr)`, so `played_hz` returns the measured f
([measured preset §4](../development/measured-plywood-preset-2026-10-15.md#4-frequency-and-damping),
[Basic OVERVIEW → Piano_mode](../modules/pianoid-basic/OVERVIEW.md#piano_mode-and-modemap)). If the check value
does not come out, say so rather than adjust the formula.

### R4: compare two renders (A/B) {#r4}

Two exports (for example p60 on the 10-15 and the 10-17 preset, or before / after an edit). Different presets
have different `output_scale`, so compare **normalised** spectra: per-band level differences in dB after
normalising each render to its own RMS, and the peak list of R1 for each. State that absolute loudness is not
comparable across presets.

### R5: modal overlap of a mode list {#r5}

Overlap factor per mode = half-power bandwidth / mean spacing to the neighbours = 2ζf / Δf. Above about 1 the
single-mode estimators (half-power, peak picking, free decay) are biased: prefer PolyMAX values. Pure arithmetic
on a list from the doc or from `param.get` (R3).

## Decision tables {#decisions}

### Symptom → what to check {#decisions-symptoms}

| Symptom / question | Check | Meaning |
|---|---|---|
| A low peak: board mode or exciter? | Does it move between exciters, or with added mass on the exciters? | Stays at the same f for every exciter and with the weights → board mode. Follows each exciter's fs (and moved with the weights) → exciter suspension resonance |
| A peak at 36–39 Hz | the [fs table](#rig-resonances) | 10-14: the exciters' own resonances |
| A "mode" at 49.7–50.1 Hz with ζ ≈ 0.4 % | mains | hum; exclude 50 Hz and harmonics |
| Exciters "disagree" on a mode's shape | overlap factor (R5), number of sensors | overlap + 7 sensors, not noise; below 200 Hz the agreement returned once neighbours were modelled (10-12: median MAC 0.31 → 0.90) |
| A free decay gives a much larger ζ than PolyMAX | envelope residual, decay frequency vs target | beating with a neighbour; use PolyMAX with the decay as an upper bound |
| One exciter's level differs by many dB per volt | coil admittance | electrical (per volt); per ampere removes most of it. "Out 1/2 vs 3/4" followed the exciters and the MAIN knob |
| Motion distortion high, coil current clean | B3 ladder | mechanical (mounting): lower the level, ask the user to inspect |
| Coil-current rows look like extra sensors | crosstalk | not usable (shared return −42 … −45 dB); force references only |
| Below 30 Hz, MIMO vs sweep differ 10–20 dB | — | open; use the sweep below 35 Hz |
| E1 / E2 silent on the board with the measured preset | `system.environment` `output_map` | missing map: they went to the monitor Outs 1 / 2 |
| Measured preset "too quiet" in raw numbers | `render.note_playback` `all_zero` | raw peak about 1e-8 is normal for this preset |
| Level way off after a load | `preset.load_settings` mismatches, `output_scale` stale | reload at the declared settings |

### The 32.5 Hz question (history) {#d-32hz}

| Date | Claim | Evidence |
|---|---|---|
| 10-12 | 33.0 Hz among the five modes all 4 exciters agree on (MAC ≥ 0.9) | stepped sine E1–E3 |
| 10-14 | "probably a board mode": the P8 peak stays at 32–33 Hz for E1 / E2 / E3 although their fs differ (31.8–37.8 Hz); moderate confidence, one sensor | B2 |
| 10-15 morning | refuted: with the weights the E1 / E2 / E3 peak moved to 28–30 Hz with the exciters' fs; board peaks at 60–400 Hz did not move | B2 weights |
| 10-15 | **retracted ("withdrawn")**: E3–E6 keep a 30–34 Hz feature on both days; the weights also changed the board-side response (an 18.4 Hz peak vanished, −3 … −5 dB above 60 Hz at P8); a 2-DOF model test was inconclusive | weights before / after analysis |
| 10-15 | status **OPEN**; settling it needs the exciter dynamics removed (tap / hammer test with the reaction masses blocked or the exciters detached). The user decided **not to pursue** it; 32.7 Hz is not in the measured preset | fd69 log; measured preset §3 |

Do not re-open it unless the user asks; if asked, propose the tap test, not another sweep.

### "Matches only at chance level" {#d-chance}

| What | Result | Use |
|---|---|---|
| Per-exciter ESPRIT across exciters (impulse or chirp) | matched pairs and shape MAC at chance (MAC 0.11–0.28) | do not use ESPRIT on this board |
| Cross-exciter shape agreement 200 Hz–1.1 kHz | near chance (7 sensors; chance MAC about 0.10–0.14) | frequencies and ζ are solid there, shapes are not |
| The 49.69 Hz mode (10-15) | cross-exciter MAC 0.12 = chance | dropped as mains-contaminated |
| FPGA (F15 / Dima) mode list vs the measured board modes | **UNKNOWN**: no source compares them. The measured preset dropped every F15 mode below the boundary by the user's decision, not by a comparison | if asked, say so; a comparison would be an analysis task (R1 on both presets) |

## Known results (settled, do not redo) {#known}

- **Modes below 200 Hz** (consensus over 4 full 7 × 7 runs, 10-14): 32.7, 53.2 (weak), 62.4, 67.6, 76.4, 80.8,
  94.9, 107.2, 109.7, 117.6, 122.9, 133.0, 137.2 (marginal), 141.9, 145.6 / 152.2, 154.8, 159.8, 175.1, 190.2 Hz;
  ζ about 2–3 %. Not confirmed: 35.6 / 36.2, 47.8, 57.9–59.1 Hz; 48.4 Hz not supported; 38.7 Hz weak.
- **200 Hz–1.1 kHz:** 43 modes, frequencies solid (48 of 58 match 10-13 within 2 %, median 0.18 %), damping median
  1.6 %; shapes not reliable.
- **Damping:** about 2–3 % below 150 Hz, about 1.6 % from 150 Hz to 1 kHz; PolyMAX is right (ratio 1.01 to the
  appropriated decays); the weights had no clear effect on ζ (ratio median 0.98).
- **Repeatability:** f about 0.3 %, ζ about 0.2 pp; drift 0.13 % over 1.7 h.
- **Methods:** PolyMAX + consensus primary, swept joint fit cross-check, per-exciter ESPRIT out.
- **Appropriation:** the mode-derived vector at equal coil current is within about 0.3 dB of the optimum on the
  target mode (24 modes); real signed weights suffice.
- **The measured preset** `F15_measured_plywood_2026-10-17`: built, offline-verified (f within 0.16 c, ζ within
  0.78 %, channel ratios within 0.0074 dB), equalized; the 10-15 version was played on the board (no clipping,
  ≤ −31 dBFS). The table of the 39 measured modes is [measured preset §12 + §14.1](../development/measured-plywood-preset-2026-10-15.md#12-mode-table-measured-modes-037).
- **User decisions 2026-10-17** ([§14](../development/measured-plywood-preset-2026-10-15.md#14-decisions-2026-10-17-preset-f15_measured_plywood_2026-10-17)):
  bass left as measured (no lift); no voltage trims; boundary 1020 Hz; 220.07 Hz ζ = mean 1.3775 %; couplings stay
  the nearest-F15 placeholder; full-range equalization accepted; MIDI player handled separately (`mido`).

## Open questions and limits {#open}

| Open / limit | Status | What would settle it |
|---|---|---|
| E2 mounting inspection | UNKNOWN (planned 10-15) | the user's inspection, then the B3 distortion check again |
| 32.5 Hz | OPEN, not pursued (user) | tap / hammer test with the exciters blocked or detached |
| Absolute force and modal mass | no force calibration, no accelerometer; scales are relative | S0–S1b of the program: volt / amp calibration, impedances, added-mass Bl |
| Electrical damping of the attached exciters | estimated +2 … 8 % of ζ, not measured | open-coil check: drive E7, stop-decay with E1–E6 unplugged vs plugged (about 10 min) |
| Shapes above 200 Hz, close clusters below 200 Hz | 7 sensors cannot resolve | more sensors (2nd UMC over ADAT), a roving grid (200 mm / 30 points, then 100 mm / about 110 points), P8 at E7 kept as the cross-session reference |
| 1–2 kHz and above | no usable model | a vibrometer or a roving hammer |
| Below 30 Hz MIMO vs sweep | open | not per-exciter stick-slip; arises only with 7 at once |
| Per-ampere reprocessing of the 10-14 data (S7) | planned, not reported | computation only, no rig time |
| Couplings of the measured modes to the strings | placeholder by decision | derive from shapes at notional bridge points (user decision) |
| Current state of the rig (wiring, weights) | UNKNOWN to the docs | ask the user |

### Branch status {#branch-status}

As of 2026-10-19: the Core branches `feature/dev-fd69-modal-methods` (which contains `feature/dev-4284-asio-collection`
and `feature/dev-69fd-swept-discovery`) are **not merged into Core `dev`**. They carry the PolyMAX, swept
discovery, appropriation, rig-check and ASIO-acquisition code that the measurement scripts use. The merge is
reviewed and staged (dev-db3c): Core `feature/dev-db3c-fd69-integration` (worktree `D:\repos\wt-db3c-core`) and
Tunner `feature/dev-db3c-fd69-integration` (`D:\repos\wt-db3c-tunner`, the ASIO channel pickers and the
chirp selector) merge cleanly onto `dev` with tests green. It lands after a HEAVY rebuild, because it retires
`sdl_audio_core` and changes `build_pianoid_cuda.bat`. Until then the CLIs run from `D:\repos\wt-fd69-core`. The measured
preset work (dev-a709, dev-b8e3) **is** merged (Core dev a67f132 / 537e7e6, Basic dev 4de6f9a): the preset
files, the builder `Pianoid.measured_mode_preset` and the 12-channel engine with the output map.

## Gaps: steps with no command {#gaps}

| Step | Missing | Today |
|---|---|---|
| 1–4, 6, 8 (rig capture) | a registry command over `POST /audio/session` (play a signal on chosen outputs, record chosen inputs) | agent scripts |
| 5–7 (PolyMAX, consensus, LSFD, shapes) | an analysis command / job; the code is on the unmerged fd69 branch | agent scripts / CLIs |
| any | importing a recording (`.npz`, session WAVs) as an analysis artefact | `analysis.run_python` takes only render / `param.get` / `preset.summary` artefacts |
| 9 (builder, carry-over, Layer B) | a build / Layer B command | agent scripts |
| 11 (level on a sensor) | an exportable mic / piezo capture (`/measure_rms` and `play.keyboard capture_mic` are not exportable artefacts) | the user listens; `system.health` peaks |
| 10 (output map) | a way to set `PIANOID_AUDIO_OUTPUT_MAP` | the user restarts the backend with the variable |

## Data layout (`D:\modal_measurements\rig_checks`) {#data-layout}

For orientation when talking to the user or handing over to an agent (the assistant cannot read it):

- One folder per capture: `<YYYYMMDD>T<HHMMSS>-<label>` (for example `20261015T124849-7x7-piezos-weights-r1`,
  `20261015T142258-q-decay`), with `sessions\` (the per-session recordings), a `config.json` or
  `capture_log.json`, and the step's JSON results (`prep.json`, `plan.json`, `live_log.json`, `eval.json`,
  `q_decay.json`); a sibling `<folder>.log` when the capture logged to a file. `-ABORTED` marks an aborted run.
- Analysis-only folders: `<label>-<YYYYMMDD>` (`consensus-lt200-20261014`, `q-confidence-20261015`,
  `mode-shapes-20261015`, `weights-before-after-20261015`, `compare-20261014`).
- Layout: `layout-20261014\board_layout.json`: normalised coordinates (x 0 = left … 1 = right, y 0 = top … 1 =
  bottom of the board as photographed, piezo face) for `piezos_green` 1–8 and `exciters_red` 1–7, plus the pixel
  positions and the photo.
- Helper scripts at the top level: `wiring_*`, `drivingpoint_*`, `frf4ref_*`, `rove_*`, `current_analyse.py`.
- Earlier data: `D:\modal_measurements\swept_discovery\`, `appropriation\`, `analysis\dev-fd69-2026-10-1{1,2}\`.

## Sources {#sources}

- [Consolidated report 2026-10-14](../development/report-mode-discovery-2026-10-14.md) ([ru](../development/report-mode-discovery-2026-10-14.ru.md))
- [Progress report 2026-10-12](../development/report-mode-discovery-2026-10-12.md) ([ru](../development/report-mode-discovery-2026-10-12.ru.md)): theory, method comparison
- [Modal methods with attached exciters 2026-10-11](../development/modal-methods-attached-exciters-2026-10-11.md)
- Dima's adjust_tr_10e vs Pianoid: `development/dima-vs-pianoid-mode-discovery-2026-10-11.md` (in the main
  checkout, not committed as of 2026-10-19): current vs voltage reference, his stepped-sine method and its limits
- [Measured plywood preset](../development/measured-plywood-preset-2026-10-15.md), incl. §14 (decisions 2026-10-17)
- dev-fd69 session log `development/logs/dev-fd69-2026-10-11-165927.md` (10-13 … 10-15: currents, weights, 32.5 Hz retraction, appropriation, Q)
- [WORK_IN_PROGRESS → follow-ups of dev-fd69, dev-4284, dev-69fd](../development/WORK_IN_PROGRESS.md)
- [AUDIO_DRIVERS → ASIOAudioDriver](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver) (output map, mic capture input), [ASIO Measurement Session](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asio-measurement-session-dev-1b6c)
- [Modal Adapter Pipeline Guide](MODAL_ADAPTER_GUIDE.md) and [REST_API → modal routes](../modules/pianoid-middleware/REST_API.md#post-modalrun_pipeline) (the ESPRIT pipeline behind `modal.run_stage`)
- Command registry: `schemas/commands/*.json`; the assistant's own rules: [Operations primer](OPERATIONS_FOR_ASSISTANT.md)
