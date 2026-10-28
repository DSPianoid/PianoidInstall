# Mode Discovery Guide (soundboard measurement, for the assistant)

**Audience:** the in-UI Pianoid assistant (and anyone who needs the measurement procedure in one place). **Owner:**
dev-modeguide, 2026-10-19; rig commands dev-8a9e, 2026-10-19. Everything below is distilled from the measurement reports and logs listed in
[Sources](#sources); each section names its source. Where the sources do not support a claim, it is marked
**UNKNOWN**. Do not fill those in: say so and offer the measurement that would settle it.

Read this page with `read_docs` (page `guides/MODE_DISCOVERY_FOR_ASSISTANT.md`) and the anchor that fits:
`can-do`, `rig-commands` (or one: `cmd-capture`, `cmd-sine`, `cmd-record`, `cmd-process`, `cmd-create`,
`cmd-reads`), `example`, `rig`, `ladder` (or a step: `step-0` … `step-11`), `recipes`, `decisions`, `known`,
`open`, `gaps`, `data-layout`.

## What the assistant can and cannot do here {#can-do}

Since dev-8a9e (2026-10-19) the assistant runs the **whole ladder itself** through fixed, typed commands (no shell,
no file paths): ASIO capture, sine and record on the rig, the FRF matrix, PolyMAX, the exciter coefficients, the
measured-preset builder and a new preset structure. Every command and parameter is in [Rig commands](#rig-commands);
the end-to-end example for a 7-exciter / 8-piezo rig is the [Worked example](#example). What still needs the user:
the wiring, the output map of the backend, and listening.

| The assistant can (registry name) | Category |
|---|---|
| `system.snapshot`, `system.environment` (incl. the output map), `system.health` (peaks, clipping), `audio.devices` (ASIO in / out list), `calibration.mic_devices` | read, no confirm |
| `preset.files`, `preset.summary`, `preset.load_settings`, `param.get`, `param.inventory` | read, no confirm |
| `modal.rig_runs` (measurement runs and their files), `modal.rig_files` (`export: true`: run files -> an analysis artefact), `modal.measurements_dir` (where the measurement data lives) | read, no confirm |
| `modal.set_measurements_dir` (moves the measurements folder; data is not moved) | **asks every time** (its own rule; the user may set it to Always allow) |
| `modal.rig_capture` (sweeps per exciter, inputs recorded), `modal.rig_sine` (a tone, optional recording), `modal.rig_record` (inputs only) | **asks every run** (its own rule; the user may set it to Always allow) (drives / records the rig) |
| `modal.rig_process` (`frf`, `polymax`, `coefficients`, `build_preset`), `preset.create` (a new preset structure) | **asks every run** (its own rule; the user may set it to Always allow) (writes files) |
| `modal.rig_cancel` (stops the rig job), `job.get`, `job.list`, `job.cancel` | playback / read |
| `preset.load`, `modal.run_stage`, `modal.apply_to_preset`, `calibration.synthesis`, `calibration.attack_equalize`, `launcher.modal.start` | **asks every time** (its own rule; the user may set it to Always allow) |
| `render.note_playback`, `render.chart`, `render.keyboard` (offline; `export: true` makes an artefact) | renders (asks while live audio plays unless `renders_live` is Auto) |
| `play.note`, `play.mode`, `play.reset` (live: the sound goes to the exciters on the board) | playback |
| `param.mute_modes`, `param.mute_channels`, `param.set` | params (Ask unless Auto / Autonomous / a plan; then free, any size, under the physical gates: CFL undo, clipping revert) |
| `analysis.run_python` on artefacts from renders / `param.get` / `preset.summary` / **`modal.rig_files`** | code (Ask by default, may be Auto or a plan step; always asks in a web-tainted turn) |

| The assistant cannot | Why |
|---|---|
| Set `PIANOID_AUDIO_OUTPUT_MAP` | an environment variable of the backend process; the user restarts the backend with it. The rig commands address **physical** outputs by name (`Out 9`) and do not need it; playing the preset does |
| See the wiring (which exciter / piezo is on which jack) | ask the user; the last documented wiring is in [Rig facts](#rig) |
| Drive above **−24 dBFS** | the safe ceiling of every rig `level_dbfs` (registry maximum, checked again by the step) |
| A gap-free tone longer than `chunk_s` | an `/audio/session` session is at most 120 s; long / `until_stopped` tones run in chunks with a short gap |
| The 18-fit consensus below 200 Hz, shape plots on the board map, the Layer B recalibration | no command: run several `polymax` fits with other `band_edges` / `p_max` and compare ([R7](#r7)), or hand over |

**Safety (applies to every live step).** Rig audio drives seven exciters on a real board. Always say in one line
what will play, on which outputs, how loud and how long, and get the user's yes (the confirm dialog shows the args
again). For the whole pipeline, ask once instead with `request_plan_approval` (steps + the narrowest envelope; the
user ticks which commands with their own rule it covers; a step outside it still asks — [Operations → plan approval](OPERATIONS_FOR_ASSISTANT.md#plan-approval)). Never play loud or long audio unprompted; run a capture with `dry_run: true` first (plan, no sound). The
documented working levels are in [Rig facts → levels](#rig-levels); the playback ceiling used on 10-15 was
per-output peaks ≤ −30 dBFS (measured ≤ −31 dBFS), with E2 at −6 dB. Read `system.health` (`peak_level_now`,
`clipping_now`) after any live step. Every rig command needs a preset loaded on the **ASIO callback driver**
(`audio_driver_type 4`); synthesis pauses during each session and resumes after it.

## Rig commands {#rig-commands}

Source of truth: the registry args (`schemas/commands/modal.json`, `preset.json`); the ranges below are enforced
there (a violation is a 400 `invalid_args` listing every field). Channels are ASIO names (`Out 9`, `In 1`,
`ADAT 3`) or 0-based indices. Every write command returns a `jobId`: follow it with `job.get {jobId, wait_s: 60}` (answers when the job ends or
after 60 s, with `pct` / `msg`; repeat until finished, failed or cancelled: a PolyMAX fit can take 2–3 minutes and
reports `band i/n (lo-hi Hz): k modes`), then `result` or `error`. One rig job runs at a time; `modal.rig_cancel` (or `job.cancel`) stops it (a sweep or chunk
already playing finishes). Runs live under `<measurements>/rig_runs/<run_id>/` (`<measurements>` = the
[measurements folder](#cmd-measurements-dir); run id `<yyyymmddThhmmss>-<label>`); older captures under
`rig_checks/` are read-only sources (`area: rig_checks`). REST contract:
[REST_API → Rig measurement pipeline](../modules/pianoid-middleware/REST_API.md#rig-pipeline).

### `modal.rig_capture`: sweeps per exciter (asks: its own rule) {#cmd-capture}

| Arg | Default | Range / values | Meaning |
|---|---|---|---|
| `exciters[]` (required) | | 1–12 × `{output, name = E<k>, level_dbfs = −42}` | drive order; channel map exciter → output; level −90 … **−24** dBFS |
| `inputs[]` (required) | | 1–16 × `{input, name = the channel}` | channel map sensor → input |
| `sweep.type` | `ess` | `ess` · `linear` | exponential or linear sine sweep |
| `sweep.f_start_hz` / `sweep.f_stop_hz` | 20 / 2000 | 1 … 20000 / 2 … 24000 | below sr / 2 |
| `sweep.duration_s` | 20 | 1 … 60 | per sweep |
| `sweep.fade_in_oct` / `sweep.fade_out_oct` | 0.25 / 0.1 | 0 … 3 | ESS fades (octaves) |
| `sweep.fade_ms` | 50 | 0 … 2000 | linear-sweep fades (ms) |
| `timing.post_roll_s` | 3 | 0.1 … 30 | decay tail recorded after each sweep (sweep + tail ≤ 110 s) |
| `timing.repeats` | 3 | 1 … 10 | sweeps per exciter (averaged by `frf`) |
| `timing.settle_s` | 1 | 0 … 60 | pause between sessions |
| `timing.noise_record_s` | 3 | 0 … 30 | silence recorded first (noise floor; 0 = skip) |
| `timing.order` | `exciter_major` | `exciter_major` · `repeat_major` | all repeats of E1, then E2 …; or E1 … En per repeat (spreads drift) |
| `guard.guard_dbfs` / `guard.step_db` / `guard.min_level_dbfs` | −6 / 6 / −60 | −60 … −1 / 1 … 24 / −90 … −24 | an exciter's FIRST take peaking above `guard_dbfs` on any input is redone `step_db` lower (not below `min_level_dbfs`) |
| `guard.stop_dbfs` | −3 | −60 … 0 | a later take above it aborts the run |
| `loopback` | null | `{output, input}` | marker loopback for sample alignment (an input not in `inputs`); null = align on the reported latency |
| `sample_rate` | the device's | 8000 … 192000 | expected rate; the engine sets it (48 kHz, block 64; not settable here: a mismatch fails) |
| `label` / `dry_run` | `capture` / false | | `dry_run` plans only (sessions, `estimated_s`, levels); plays nothing |

Total sweep time per run ≤ 1800 s. Result: `run`, `levels` (after the guard), `flags`, `peaks_dbfs` per take (the
loudest input), and with a noise record `noise_floor` (per input) + `rms_above_noise_db` `{take: {input: dB}}`:
which exciter → sensor paths carry the sweep (about 0 dB = that input heard only its own noise; judge the
capture by this, not by the take peak, which a noisy input can dominate).

### `modal.rig_sine`: a tone, optional recording (asks: its own rule) {#cmd-sine}

| Arg | Default | Range | Meaning |
|---|---|---|---|
| `frequency_hz` (required) | | 1 … 20000 | |
| `outputs[]` (required) | | 1–12 × `{output, level_dbfs = −48, phase_deg = 0}` | per-output level (≤ −24 dBFS) and phase (180 = inverted: a signed drive vector such as an appropriation vector) |
| `duration_s` | 5 | 0.1 … 600 | |
| `until_stopped` / `max_duration_s` | false / 300 | … 1800 | play until `modal.rig_cancel`, at most `max_duration_s` |
| `chunk_s` | 5 | 1 … 100 | session length of long tones (short gap between chunks; a stop lands at a chunk end) |
| `fade_in_ms` / `fade_out_ms` / `chunk_fade_ms` | 50 / 50 / 10 | 0 … 5000 / 0 … 5000 / 0 … 500 | fades at the start, the end and the inner chunk edges |
| `record_inputs[]` | [] | 0–16 × `{input, name}` | play + record (each chunk under `sessions/chunk<NNN>/`); result `levels_last_chunk` |
| `post_roll_s` | 0.5 | 0 … 10 | recording after the last chunk (the free decay after a dwell) |
| `label` / `sample_rate` / `dry_run` | `sine` | | as above |
| `sequence[]` | [] | 0–64 × `{frequency_hz, outputs[], duration_s, pause_s}` (all optional) | tones in turn: each step = the top-level tone with the step's values, then `pause_s` of silence (none after the last); not with `until_stopped`; ≤ 1800 s of tone. Sessions `s<NN>_chunk<NNN>`; result `steps[]`, `estimated_s`, with `record_inputs` also `levels_per_step` |
| `pause_s` | 1 | 0 … 600 | the default pause after each sequence step |

A sequence of exciters with pauses (e.g. 200 Hz, 3 s each, 2 s apart): `{frequency_hz: 200, duration_s: 3,
outputs: [{output: "Out 9"}], pause_s: 2, sequence: [{outputs: [{output: "Out 9", level_dbfs: -42}]},
{outputs: [{output: "Out 10", level_dbfs: -42}]}, {outputs: [{output: "Out 11", level_dbfs: -42}],
frequency_hz: 80}]}` — the top-level `frequency_hz` / `outputs` are required (the step defaults); only the
steps play.

**`asio_not_realtime` / "session aborted: timeout".** Every rig command first reads `GET /audio/devices`
→ `asio.clock`; when `realtime` is false the step refuses before anything plays: the driver does not call back
at `sample_rate / buffer_size` (`realtime_ratio` far from 1). Since dev-431a the engine opens the ASIO device at a
size the driver allows (a whole number of 64-frame blocks: 64 when allowed, else e.g. a fixed 1152) and stays in
real time there, so a fixed-buffer driver is no longer a reason to refuse. If it still refuses: tell the user to
set the interface's ASIO buffer size to 64 samples in its driver control panel, then reload the preset; re-read
the device until `clock.realtime` is true. (dev-431a)

### `modal.rig_record`: inputs only (asks: its own rule) {#cmd-record}

`inputs[]` (required, as above), `duration_s` (5; 0.1 … 110), `trigger` (null, or `{input, level_dbfs = −40,
pre_s = 0.1}`: keep the data from the first crossing minus `pre_s`, saved as `sessions/record/data_triggered.npy`),
`clip_dbfs` (−0.1: a peak at or above it = clipping), `label`, `sample_rate`, `dry_run`. Result: per channel
`rms_dbfs`, `peak_dbfs`, `clipping`, the overall `clipping` flag and the `files` for `modal.rig_files`.

### `modal.rig_process`: the pipeline steps (asks: its own rule) {#cmd-process}

`{step, run, area = rig_runs, frf | polymax | coefficients | build: {options}}`. A `rig_checks` source writes its
outputs to `rig_runs/<run>/` (with `source.json`); run the steps in this order.

| Step | Options (default; range) | Output |
|---|---|---|
| `frf` | `ir_window_s` (4; 0.1 … 30: resolution = 1 / window), `taper_frac` (0.1), `pre_samples` (30), `f_min_hz` (0 = the sweep start), `f_max_hz` (1200), `average` (`mean` · `median` over the repeats), `regularization` (1e-6), `noise_from_repeats` (false: store the repeat variance for PolyMAX), `exciters` / `inputs` (label subsets; [] = all) | `frf/frf.npz` (f, H [repeats, F, inputs, exciters]), `frf/coarse_frf.npz` (freqs, H3 = the average), `frf/report.json` (labels, repeat SNR per path) |
| `polymax` | `p_max` (40; 4 … 120), `band_edges` (30, 60, 120, 250, 500, 1000, 2000, 4000, 9500), `overlap` (0.15), `max_lines` (4000), `f_min_hz` / `f_max_hz` (0 = the FRF's), `snr_detect_db` (10), `prune` (true), `prune_min_gain` (0.2), `prune_min_snr_db` (10), `loo` (false), `stab` {`p_min` 2, `tol_f` 0.01, `tol_zeta` 0.1, `tol_mpf` 0.9, `zeta_min` 1e-4, `zeta_max` 0.2, `min_stable_frac` 0.3, `use_mpf` true}, `hum_hz` (50) / `hum_harmonics` (3) / `hum_width_hz` (1): lines removed before the fit | `polymax/report.json` (per mode f, ζ, stability, shape, MPF), `polymax/modes.npz`, `polymax/stabilization.png` |
| `coefficients` | `method` (`residue_svd` · `modal_appropriation`), `f_min_hz` (20), `boundary_hz` (1020), `min_stability` (0.3), `max_fit_residual` (1), `min_rank1_ratio` (0), `zeta_min` / `zeta_max` (5e-4 / 0.2), `mass_trend` (`fit` · `none`), `mass_clip_db` (6), `ridge` (1e-3), `zeta_overrides[]` (`{f_hz, zeta, tol_hz = 1}`, e.g. a stop-and-decay ζ), hum options as above | `coefficients/measured_table.json` (the builder input: per mode f, ζ, `mass_inv_rel`, real channel weights with max \|·\| = 1, below `boundary_hz`), `coefficients/report.json` (dropped modes and why, the trend exponent, energy kept by the real projection) |
| `build_preset` | `name` (required), `base_preset` (`F15_Elyashev_array512`; needs keys 21..108), `n_modes` (196; ≤ measured + base modes above the boundary unless the base's FPGA tables are on this machine), `hf_level` (`energy` · `max`), `seed` (0), `num_strings` / `array_size` (0 = keep; else the structure change of `preset.create` first), `string_removal`, `overwrite` (false) | a NEW `presets/<name>.json`: measured modes below the boundary, the base's above, one channel per exciter with the weights; result `n_measured` + `n_base_kept_above_boundary` + `n_fill_from_fpga_tables` = `n_modes` |

Laws ([measured preset §5, §6](../development/measured-plywood-preset-2026-10-15.md)): relative 1/m ∝
σ1 · max\|u\| · max\|v\| of each mode's residue matrix (inputs × exciters), its power-law trend over f removed
(instrument chain), the rest clipped to ± `mass_clip_db`; weights = the real projection of the drive vector
(rotate by the largest entry's phase, real part, max \|·\| = 1). **These weights are per drive volt** (the
capture's reference); the 10-17 preset used per-ampere weights from coil currents.

### `preset.create`: a new preset structure (asks: its own rule) {#cmd-create}

| Arg | Default | Range | Meaning |
|---|---|---|---|
| `name` (required) | | letters, digits, `. _ -` | `presets/<name>.json`; an existing name is refused unless `overwrite: true` |
| `num_strings` (required) | | 8 … 256, a multiple of 4 | piano strings + the output strings (`ceil(channels / 4) × 4`) |
| `num_channels` (required) | | 1 … 12 | output pitches 128 … 127 + n (one per exciter) |
| `array_size` (required) | | 384 … 512 | the string geometry is scaled by new / old; every block must fit |
| `num_modes` | 0 (keep) | 0 … 2000 | keep the first N modes |
| `base_preset` | `F15_Elyashev_array512` | | a preset in `presets/` |
| `string_removal` | `treble_first` | `treble_first` · `bass_first` | which unisons lose a string (3-string ones first); try the other order if a block does not fit |
| `overwrite` | false | | |

The new channels copy the base's first output row (equal weights); `modal.rig_process build_preset` writes the
measured weights. The output scale is marked uncalibrated (the engine re-derives it at load). Adding strings or
modes beyond the base is refused.

### `modal.rig_runs`, `modal.rig_files`: reads (no confirm) {#cmd-reads}

`modal.rig_runs {area, limit}` lists the runs (id, kind, steps done, size); with `{run}` it gives one run's config,
step reports and every file (relative names). `modal.rig_files {run, area, files: [≤ 10 relative names], export:
true}` copies them into ONE analysis artefact (names flattened: `sessions/E1_m42_r1/data.npy` →
`sessions__E1_m42_r1__data.npy`; at most 400 MB) whose id `analysis.run_python` takes ([R6](#r6)).

### `modal.measurements_dir`, `modal.set_measurements_dir`: the measurements folder {#cmd-measurements-dir}

Every rig command (capture, sine, record, process, runs, files / export) and the modal adapter use ONE folder.
`modal.measurements_dir {}` (read, no confirm) answers `{measurements_dir, source, exists, setting, env, default,
settings_file}`; `source` says which layer won: `setting` (the runtime setting) > `env`
(`PIANOID_MEASUREMENTS_DIR`) > `default` (`<PianoidInstall>/measurements`, next to the install, on any drive).
`modal.set_measurements_dir {path}` (asks: its own rule) sets the runtime setting: an ABSOLUTE folder that exists or can
be created and is writable (it is created); `path: null` clears it. The choice persists across restarts (the
gitignored `pianoid_local_settings.json` in the install root). It never moves data: runs in the old folder are no
longer listed, so tell the user; it is refused while a rig job runs. Use it when the user asks to keep
measurements elsewhere (another drive, a shared folder), or when `modal.rig_runs` shows an unexpected empty
folder: read `modal.measurements_dir` first. Contract:
[REST_API → Measurements folder](../modules/pianoid-middleware/REST_API.md#measurements-folder).

## Rig facts {#rig}

Source: [report 10-14 §1, §3, §5](../development/report-mode-discovery-2026-10-14.md), the dev-fd69 session log
(`development/logs/archive/dev-fd69-2026-10-11-165927.md`, 10-14 evening … 10-15), [measured preset §2, §6,
§10b](../development/measured-plywood-preset-2026-10-15.md), [AUDIO_DRIVERS → ASIOAudioDriver and Rig
facts](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver).

### Board, interface, transducers {#rig-board}

| Fact | Value | Source |
|---|---|---|
| Board | 8 mm plywood, about 1200 × 1000 mm (no bridge, no strings). Mass used for the preset: 650 kg/m³ → M = 6.24 kg | measured preset §2, §5.2 |
| Interface | Behringer UMC1820, `UMC ASIO Driver`; 18 in / 20 out (`In 1`–`In 8`, `Out 1`–`Out 10`, SPDIF, ADAT); every channel Int32LSB; the engine opens it at 48 kHz, buffer 64 (its driver offers powers of two 8 … 2048 only) | AUDIO_DRIVERS rig facts |
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
| Live current limit (playback) | the exciter monitor (`audio.exciters` read, `audio.exciters_config`: its own risky rule) meters the sense / board inputs during normal playback and limits each exciter's current; it needs the input map + scales set per machine (default OFF, uncalibrated). [REST_API → Exciter monitor](../modules/pianoid-middleware/REST_API.md#exciter-monitor) |

## The procedure ladder {#ladder}

Each step: purpose, the command (or the hand-off), parameters, expected output, acceptance, pitfalls, safety.
Timing comes from [report 10-14 §7](../development/report-mode-discovery-2026-10-14.md). The minimum trustworthy
session below 200 Hz is about 45 min (3 × full 7 × 7 + consensus); the minimum useful one about 20 min.

Each step names its **command** ([Rig commands](#rig-commands)). The agent scripts of the original sessions
(`docs/development/diagnostics/`, `<measurements>/rig_checks/*.py` on the measuring machine) are kept as references; the commands
are their parametric form (dev-8a9e). See [Branch status](#branch-status).

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
- **Output map vs channel count (fixed 2026-10-20, dev-16af):** with `PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6`
  (7 entries) a preset with FEWER channels loads on the first N outputs (`output_map_warning` in the result); one
  with MORE channels is refused (`409 output_map_mismatch`) and the running engine is kept. A Tunner tab no longer
  re-applies its stored load over a different loaded preset. Play the measured 7-channel preset with `preset.load`.

### Step 1: wiring / ID check {#step-1}

- **Purpose:** prove each output drives the exciter you think, and each input carries its own sensor.
- **Commands:** `modal.rig_record` (silence 5–10 s, all inputs: the floor and hum per input), then one short
  `modal.rig_capture` as ID bursts: every exciter at −42 dBFS, `sweep {f_start_hz: 100, f_stop_hz: 2000,
  duration_s: 1}`, `timing {repeats: 1, post_roll_s: 2, settle_s: 1}` (about 1 min); `modal.rig_runs {run}` then
  shows `peaks_dbfs` per exciter × input (or export a session with `modal.rig_files` and compare levels with
  `analysis.run_python`). A single exciter: `modal.rig_sine` (e.g. 200 Hz, −42 dBFS, 1 s) with `record_inputs`.
- **Acceptance:** with coil currents on the inputs, In k answers only Ek (own current +30 … +39 dB, crosstalk 24–33
  dB down); with piezos, every exciter reaches the board; the E7 → P8 IR peak is at a stable sample within the
  session; the passive record shows the floor plus 50 Hz hum only.
- **Pitfalls seen:** a silent exciter (E3 on 10-15), E6 dropping out (10-14) or weak (10-15), a weak piezo on In 5
  (10-13), unequal input gains (up to 20 dB, 10-13): equalise the gains and probe first.
- **Safety:** short, quiet bursts; still confirm.

### Step 2: driving point and exciter admittance {#step-2}

- **Purpose:** each exciter's fs and admittance (needed for per-ampere data and to tell exciter resonances from
  board modes).
- **Command:** `modal.rig_capture` with `sweep {f_start_hz: 15, f_stop_hz: 200, duration_s: 20}`,
  `timing.repeats: 2`, and the coil-current inputs in `inputs` (5.7 min for 7 exciters); then `modal.rig_process
  frf` (`f_max_hz: 200`, `ir_window_s: 8`). The admittance is the exciter's own current row of H; read it with
  `modal.rig_files` + `analysis.run_python`.
- **Expected:** the fs table above; admittance flat above 60 Hz.
- **Pitfall:** per ampere is not per newton near fs (inertial exciters). There is no force calibration and no
  calibrated accelerometer, so all scales are relative.

### Step 3: linearity and distortion ladder {#step-3}

- **Purpose:** choose safe levels; find a distorting exciter.
- **Commands:** one `modal.rig_capture` per level (`sweep {f_start_hz: 20, f_stop_hz: 10000, duration_s: 8}`,
  `timing.repeats: 1`, levels e.g. −48 / −42 / −36 / −30 dBFS; `label` per level), plus `modal.rig_sine` tones with
  `record_inputs` (H2 / H3 from the spectrum in `analysis.run_python`). Compare the `frf` of the runs.
- **Acceptance:** the linear FRF scales within 0.5 dB per +6 dB; H2 of motion vs the coil current tells mechanical
  from electrical distortion.
- **Decision rule:** an exciter whose motion H2 is well above its current H2 is mechanical (mounting): lower its
  level (E2 −6 dB) and ask the user to inspect it.

### Step 4: multi-exciter excitation (the FRF matrix) {#step-4}

- **Purpose:** the 8 × 7 (sensors × exciters) FRF matrix that every extraction uses.
- **Commands:** `modal.rig_capture` (defaults = the 10-14 / 10-15 protocol: ESS 20 Hz–2 kHz, 20 s + 3 s tail,
  3 repeats, 21 sessions, about 9 min at the [sweep levels](#rig-levels); `dry_run: true` first), then
  `modal.rig_process {step: frf}`. A dedicated LF run below 35 Hz: `sweep {f_start_hz: 15, f_stop_hz: 150,
  duration_s: 30}`. MIMO multisines (all exciters at once) have no command.
- **Acceptance:** 0 xruns; peaks below the guards; repeat coherence high (10-12: γ² ≥ 0.9996, 42–48 dB repeat SNR).
- **Pitfalls:** below 30 Hz the 7-exciter multisine and the sweep differ by 10–20 dB (unresolved, not per-exciter
  stick-slip): use the sweep there. Per-volt data favour the hot outputs (Out 9 / 10): use per-ampere data
  (each exciter's measured admittance) and drive at **equal coil-current RMS**.
- **Safety:** about 9 min of sweeps on 7 exciters: confirm the plan and levels with the user first.

### Step 5: mode extraction {#step-5}

- **Purpose:** poles (f, ζ) and residues from the FRF matrix.
- **Method ranking on this board** ([report 10-12 §4, §6.1](../development/report-mode-discovery-2026-10-12.md)):
  1. **PolyMAX** (multi-reference pLSCF + LSFD): primary f, ζ and shapes up to about 1.1 kHz; its ζ matches the
     model-free decays (ratio 1.01). Command `modal.rig_process {step: polymax}` (e.g. `polymax.f_max_hz: 1100`).
  2. **Consensus below 200 Hz:** single PolyMAX fits there are unreliable (the same data gave different lists).
     Run **18 fits per run** (3 band sets × 2 orders × 3 bootstrap) over ≥ 3 runs and keep the poles that recur.
     Script `dev-fd69-consensus-lt200-2026-10-14.py` (190 s per run); with the commands: several `polymax` fits
     with other `band_edges` / `p_max` and a comparison in `analysis.run_python` ([R7](#r7)).
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
- **Commands:** PolyMAX ζ per run (`polymax` on each capture run). Stop-and-decay (live): `modal.rig_sine` at
  f_m with the mode's drive vector (`outputs[].level_dbfs` / `phase_deg` from the coefficients weights), a steady
  `duration_s` (e.g. 3 s), `fade_out_ms` 5, `record_inputs` all piezos and `post_roll_s` ≥ max(1 s, 12 τ); fit the
  decay in `analysis.run_python` ([R2](#r2) on the exported chunk); max −36 dBFS (E2 −42). A chosen ζ goes back with
  `coefficients.zeta_overrides`. (Reference scripts: `dev-fd69-q-confidence-2026-10-15.py`,
  `dev-fd69-q-decay-2026-10-15.py`.)
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
- **Command:** the `polymax` report holds per mode the shape over the inputs and the MPF over the exciters;
  `coefficients/report.json` the real weights. Board-mm plots: `analysis.run_python` with the layout coordinates
  (ask the user) or the reference scripts `dev-fd69-mode-shapes-appropriation-2026-10-15.py`,
  `dev-fd69-replot-shapes-mm-2026-10-14.py`.
- **Expected per mode:** u, v, rank-1 share, cross-exciter MAC, repeat MAC; reliability class.
- **Pitfalls:** shapes repeat run to run (MAC 0.95) but different exciters see different shapes (about 0.3): the
  modes overlap and 7 sensors cannot separate them. That is the main limit, not noise. **Shapes are not
  comparable across days** (the piezos never sat in the same place twice); frequencies and damping are.

### Step 8: appropriation (drive each mode with its own vector) {#step-8}

- **Purpose:** check that driving the exciters in proportion to a mode's drive vector excites that mode; this
  vector becomes the preset's channel weights.
- **Commands:** per mode `modal.rig_sine` at f_m with the weights as levels and signs (`phase_deg` 0 / 180;
  level_k = max level + 20 log10 \|w_k\|), `duration_s` 3 (2 s settle + 1 s lock-in), `record_inputs`; compare with
  a best-single and a uniform vector (lock-in amplitude in `analysis.run_python`). Max −36 dBFS (E2 −42). The
  10-15 protocol (equal coil-current RMS, 3 random vectors) is `dev-fd69-appropriation-live-2026-10-15.py`.
- **Acceptance (10-15, 24 modes):** the mode vector beats single / uniform / random in every mode; median −0.3 dB
  on the target mode and −0.6 dB on the total response vs the optimum; live − predicted about 0 dB median (max
  2.3 dB at 220 Hz).
- **Pitfall:** the optimum maximises total response, so where modes overlap it also drives the neighbours; real
  signed weights (decka form) are as good as complex ones on this board.

### Step 9: build the measured preset {#step-9}

- **Purpose:** replace the base preset's low modes with the measured ones. Done twice:
  `F15_measured_plywood_2026-10-15` and, with the user's decisions, **`F15_measured_plywood_2026-10-17`** (the
  current one; the 10-15 file stays for A/B).
- **Commands:** `modal.rig_process {step: coefficients}` (`boundary_hz` 1020; ζ choices via `zeta_overrides`)
  → `modal.rig_process {step: build_preset, build: {name, base_preset, n_modes, num_strings, array_size}}` (a NEW
  preset; a different structure in the same step, or `preset.create` alone). Then `preset.load` at the declared
  settings and `calibration.synthesis` (equalization; not while live audio plays). Not covered by a command: the
  10-17 carry-over of the HF weights and the Layer B recalibration (`dev-b8e3-carry-hf-weights-2026-10-17.py`,
  `dev-a709-verify-preset-2026-10-15.py --write-layer-b`), the per-ampere residues (`dev-a709-measured-modes`);
  the 10-17 reproduction is [measured preset §14.6](../development/measured-plywood-preset-2026-10-15.md#146-reproduce-10-17).
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
  `preset.load {path}` (asks: its own rule). Then `preset.load_settings`: if `mismatches` is not empty, reload with the
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
`render.keyboard`, `param.get`, `preset.summary` or **`modal.rig_files`** (rig recordings and pipeline outputs).
In the code: `ARTIFACTS[id]` (the meta), `artifact_path(id)` (the first file; `artifact_path(id, 'series_0.npy')`
for another), and `OUT` for PNG / CSV / JSON outputs. Never paste samples into the code. Renders are raw engine
units: compare renders of the same preset, report frequencies, ratios and dB differences. Rig recordings are
float32 `[frames, inputs]` at full scale 1.0, aligned to the drive (frame 0 = the sweep start).

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

### R6: a rig recording or FRF in the sandbox {#r6}

`modal.rig_runs {run}` lists the files; export what you need (≤ 10 files, ≤ 400 MB), e.g.
`modal.rig_files {run, files: ["frf/coarse_frf.npz", "sessions/E3_m36_r1/data.npy"], export: true}`:

```python
import json, numpy as np
aid = list(ARTIFACTS)[0]
d = np.load(artifact_path(aid, 'frf__coarse_frf.npz'))          # freqs (F,), H3 (F, inputs, exciters)
x = np.load(artifact_path(aid, 'sessions__E3_m36_r1__data.npy'))  # one take, (frames, inputs)
s1 = np.linalg.svd(d['H3'], compute_uv=False)[:, 0]             # CMIF: peaks = modes
print(json.dumps({'H3': list(d['H3'].shape), 'cmif_peak_hz': float(d['freqs'][np.argmax(s1)]),
                  'take_peak_dbfs': float(20 * np.log10(np.abs(x).max()))}))
```

### R7: compare two PolyMAX fits (consensus) {#r7}

Run `polymax` on the same run with other settings (e.g. `band_edges` shifted by half a band, `p_max` 30 / 50):
each run overwrites `polymax/`, so export `polymax/report.json` after each fit, then match the mode lists (a pole
recurring within 0.3 % in most fits is kept; see [step 5](#step-5)).

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

As of 2026-10-19: the rig-measurement code is **merged into Core `dev`** (68615df, dev-db3c): dev-fd69 (PolyMAX,
chirp / ESS collection, rig checks, appropriation, mode comparison, stepped-sine dwells), dev-4284 (modal-adapter
acquisition on the ASIO `POST /audio/session`, `sdl_audio_core` retired) and dev-69fd (swept discovery). Tunner
`dev` (5b42d38) has the ASIO channel pickers and the impulse | chirp selector. The CLIs run from the main
checkout `PianoidCore`; the old fd69 / 4284 / 69fd worktrees are gone. The measured
preset work (dev-a709, dev-b8e3) **is** merged (Core dev a67f132 / 537e7e6, Basic dev 4de6f9a): the preset
files, the builder `Pianoid.measured_mode_preset` and the 12-channel engine with the output map.

The rig commands (dev-8a9e, 2026-10-19): Core `rig_pipeline_routes.py` + `modal_adapter/rig_pipeline/` (ASIO
capture / sine / record, frf, polymax, coefficients, build_preset), Basic `Pianoid/preset_restructure.py` (run from
the checkout by the step, no Basic rebuild needed), the registry `modal.rig_*` / `preset.create` and the assistant's
policy and `modal.rig_files` export. A pull + backend restart + assistant restart activates them (no CUDA build).

## Gaps: steps with no command {#gaps}

| Step | Missing | Today |
|---|---|---|
| 4 | MIMO multisines (all exciters at once) | sweeps one exciter at a time (`modal.rig_capture`) |
| 5 | the automatic 18-fit consensus below 200 Hz | several `polymax` fits + [R7](#r7) |
| 6, 8 | the stepped tuning sweep / equal coil-current scaling of the 10-15 scripts | `modal.rig_sine` dwells, the levels computed by the assistant |
| 9 | per-ampere residues, the HF-weight carry-over, Layer B | reference scripts (see [step 9](#step-9)) |
| 10 (output map) | a way to set `PIANOID_AUDIO_OUTPUT_MAP` | the user restarts the backend with the variable |
| a tone longer than 110 s without gaps | `/audio/session` sessions are at most 120 s | `until_stopped` chunks |

## Data layout (`<measurements>/rig_checks`) {#data-layout}

`<measurements>` = the [measurements folder](#cmd-measurements-dir) (`modal.measurements_dir`); on the
measuring PC of the 10-11 … 10-15 sessions it is `D:\modal_measurements`. The assistant reads these through `modal.rig_runs` / `modal.rig_files` (`area: rig_checks`, read-only). Its own
runs go to `rig_runs/<run_id>/` ([Rig commands](#rig-commands)).

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
- Earlier data: `<measurements>\swept_discovery\`, `appropriation\`, `analysis\dev-fd69-2026-10-1{1,2}\`.

## Worked example: 7 exciters, 8 piezos, a 224-string / 7-channel / 384 preset {#example}

The rig: exciters E1..E7 on **Out 9, Out 10, Out 3 … Out 7** (the engine's output map `8,9,2,3,4,5,6`, 0-based),
piezos P1..P8 on **In 1 … In 8** (no loopback input free: alignment on the reported latency). Every step below is
one confirmed command; say what it plays before each live one.

0. **State.** `system.snapshot` (ASIO callback driver, no fallback; a preset loaded), `audio.devices` (the UMC with
   In 1–8 / Out 1–10). Ask the user to confirm the wiring above and that D: has ≥ 5 GB free.
1. **Noise floor.** `modal.rig_record {label: "floor", inputs: [{input: "In 1", name: "P1"}, …, {input: "In 8",
   name: "P8"}], duration_s: 5}` → `rms_dbfs` per piezo (expect the floor + 50 Hz hum; no `clipping`).
2. **Plan, then capture.**
   ```json
   {"label": "dima-7x8", "dry_run": true,
    "exciters": [{"name": "E1", "output": "Out 9", "level_dbfs": -42}, {"name": "E2", "output": "Out 10", "level_dbfs": -48},
                 {"name": "E3", "output": "Out 3", "level_dbfs": -36}, {"name": "E4", "output": "Out 4", "level_dbfs": -30},
                 {"name": "E5", "output": "Out 5", "level_dbfs": -36}, {"name": "E6", "output": "Out 6", "level_dbfs": -42},
                 {"name": "E7", "output": "Out 7", "level_dbfs": -36}],
    "inputs": [{"name": "P1", "input": "In 1"}, {"name": "P2", "input": "In 2"}, {"name": "P3", "input": "In 3"},
               {"name": "P4", "input": "In 4"}, {"name": "P5", "input": "In 5"}, {"name": "P6", "input": "In 6"},
               {"name": "P7", "input": "In 7"}, {"name": "P8", "input": "In 8"}],
    "sweep": {"type": "ess", "f_start_hz": 20, "f_stop_hz": 2000, "duration_s": 20},
    "timing": {"repeats": 3, "post_roll_s": 3, "settle_s": 1, "noise_record_s": 3}}
   ```
   `modal.rig_capture` with that body returns the plan (21 sessions, about 510 s). Tell the user: "ESS 20 Hz–2 kHz,
   20 s, on each of the 7 exciters in turn, 3 times, at −30 … −48 dBFS, about 9 minutes". On yes, the same body
   with `dry_run: false`. `job.get` until finished → `run` (e.g. `20261020T101500-dima-7x8`), `levels`, `flags`.
3. **FRF.** `modal.rig_process {step: "frf", run, frf: {ir_window_s: 4, f_max_hz: 1200}}` → 8 × 7 paths, 3
   repeats, 0.25 Hz lines; check `repeat_snr_db_median` in `modal.rig_runs {run}`.
4. **PolyMAX.** `modal.rig_process {step: "polymax", run, polymax: {f_max_hz: 1100}}` → `n_modes`, the f range,
   median ζ (on the plywood board: about 40–55 modes in 20 Hz–1.1 kHz, ζ median about 1.6 %).
5. **Coefficients.** `modal.rig_process {step: "coefficients", run, coefficients: {boundary_hz: 1020,
   min_stability: 0.3}}` → `measured_table.json` (f, ζ, `mass_inv_rel`, 7 real weights per mode); check
   `coefficients/report.json` `dropped` and the trend exponent (about 2.1 on this board).
6. **The preset.** `modal.rig_process {step: "build_preset", run, build: {name: "dima_board_224_7_384",
   base_preset: "F15_Elyashev_array512", num_strings: 224, array_size: 384, n_modes: 196}}` → a NEW preset with
   224 strings (216 piano + 8 output strings), 7 channels (output pitches 128..134 = E1..E7), array_size 384, the
   measured modes below 1020 Hz and the F15 modes above. (Structure only, no measurement: `preset.create {name,
   num_strings: 224, num_channels: 7, array_size: 384}`.)
7. **Load and check.** `preset.files` → `preset.load {path, array_size: 384, …}` (asks: its own rule) → `preset.summary`
   (`num_strings 224`, `num_channels 7`, `array_size 384`) → one `render.note_playback` (not `all_zero`). The user
   restarts the backend with `PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6` before playing it on the board (step 11).

Verified offline on 2026-10-19 (dev-8a9e, no audio): steps 3–6 on the 10-15 piezo run `20261015T124849-7x7-piezos-
weights-r1` gave 42 PolyMAX modes (ζ median 1.6 %), 41 table modes reproducing 28 of the 39 published measured
modes within 0.5 % (median 0.12 %) from that single run, and a 224 / 7 / 384 preset the engine loads and renders.
Verified live through the in-UI assistant on 2026-10-20 (dev-431a, UMC1820 at 64, amplifiers apparently off): step 1
(`rig_record`, 8 inputs), step 2 dry run and a real 7-exciter capture at −48 dBFS (2 s sweeps: every session
frame-exact in real time, 0 xruns; the inputs carried only noise, so PolyMAX found 0 modes and `coefficients`
refuses with "PolyMAX found no modes"), then steps 3–7 on the real 10-15 run `20261015T124849-7x7-piezos-weights-r1`
(47 modes, 46 in the table, `dima_test_224_7_384` = 46 measured + 141 base + 9 FPGA fill, loaded, p60 renders).


## Sources {#sources}

- [Consolidated report 2026-10-14](../development/report-mode-discovery-2026-10-14.md) ([ru](../development/report-mode-discovery-2026-10-14.ru.md))
- [Progress report 2026-10-12](../development/report-mode-discovery-2026-10-12.md) ([ru](../development/report-mode-discovery-2026-10-12.ru.md)): theory, method comparison
- [Modal methods with attached exciters 2026-10-11](../development/modal-methods-attached-exciters-2026-10-11.md)
- Dima's adjust_tr_10e vs Pianoid: `development/dima-vs-pianoid-mode-discovery-2026-10-11.md` (in the main
  checkout, not committed as of 2026-10-19): current vs voltage reference, his stepped-sine method and its limits
- [Measured plywood preset](../development/measured-plywood-preset-2026-10-15.md), incl. §14 (decisions 2026-10-17)
- dev-fd69 session log `development/logs/archive/dev-fd69-2026-10-11-165927.md` (10-13 … 10-15: currents, weights, 32.5 Hz retraction, appropriation, Q)
- [WORK_IN_PROGRESS → follow-ups of dev-fd69, dev-4284, dev-69fd](../development/WORK_IN_PROGRESS.md)
- [AUDIO_DRIVERS → ASIOAudioDriver](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver) (output map, mic capture input), [ASIO Measurement Session](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asio-measurement-session-dev-1b6c)
- [Modal Adapter Pipeline Guide](MODAL_ADAPTER_GUIDE.md) and [REST_API → modal routes](../modules/pianoid-middleware/REST_API.md#post-modalrun_pipeline) (the ESPRIT pipeline behind `modal.run_stage`)
- Command registry: `schemas/commands/*.json`; the assistant's own rules: [Operations primer](OPERATIONS_FOR_ASSISTANT.md)
