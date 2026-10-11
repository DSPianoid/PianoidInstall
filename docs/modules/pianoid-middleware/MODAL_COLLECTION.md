# Modal Adapter Measurement Collection

**Status — SHIPPED (merged to PianoidCore + PianoidTunner `dev`).** The
Measurement-entity refactor is functionally complete: Phase 1 (entity + REST +
migration), Phase 2a (v1 `/modal/collect/*` → 410 + real Setup Test + streaming
messages), Phase 2b (the rebuilt 5-section Collection subpanel + shared
`<SetupTest>` + `<CollectionLog>`), Phase 2c (per-Measurement collect family +
branching, `/projects/copy` + `/create_from_zip` → 410), and the dev-maimport
campaign (import an existing dataset folder/zip as a Measurement). Since
dev-4284 (2026-10-11) acquisition runs on the ASIO measurement session of the
`:5000` backend and `sdl_audio_core` is retired (see
[§ ASIO acquisition](#asio-acquisition-dev-4284)); the old Phase 5
`SDL3.dll`-dedup item is moot.

The legacy v1 `/modal/collect/*` REST surface (Wave B-1) is **retired
to HTTP 410 Gone** as part of the Modal Adapter Measurement-entity
refactor proposal §3.4 (N8 hard cutover). The acquisition orchestrator
(`MeasurementSession` in `collection_engine.py`) is unchanged and is
the engine behind every Phase 2 endpoint:

- **Setup Test** — `POST /modal/measurements/<id>/setup_test` (Phase 2a
  shipping; runs ONE calibration impulse cycle, validates against the
  Measurement's `calibration_criteria.json`, overwrites
  `setup_test/latest.{json,wav}` per N3).
- **Per-Measurement collect** — `POST /modal/measurements/<id>/collect/*`
  + `GET /modal/measurements/<id>/devices` (Phase 2c — see
  [§ Phase 2c Per-Measurement Collect Endpoints](#phase-2c-per-measurement-collect-endpoints-dev-msmtui-fc-2026-05-11)
  below).

The single legacy survivor of the v1 retirement (per proposal §3.4 line
670) is the global probe:

```
GET /modal/measurements/active_session
```

which returns the current (or most-recent) `MeasurementSession`
snapshot, including the streaming-messages ring buffer (Q8) and the
parent `measurement_id` field. See [§ Phase 2a Backend Cutover](#phase-2a-backend-cutover-dev-msmtui-2026-05-11)
below.

**Phase 0 RR-port (dev-rrport, 2026-05-10):** the recorder, dataset
collector, signal processor, calibration validator, and SDL3 audio
extension are no longer pulled from the sibling `D:/repos/RoomResponse/`
repo at runtime. They are now vendored in-tree:

| In-tree module | Origin |
|----------------|--------|
| `pianoid_middleware.modal_adapter.measurement.recorder` | RR `RoomResponseRecorder.py` |
| `pianoid_middleware.modal_adapter.measurement.dataset_collector` | RR `DatasetCollector.py` |
| `pianoid_middleware.modal_adapter.measurement.missing_averages` | RR `generate_missing_averages.py` |
| `pianoid_middleware.modal_adapter.measurement.mic_testing` | RR `MicTesting.py` |
| `pianoid_middleware.modal_adapter.measurement.signal_processor` | RR `signal_processor.py` |
| `pianoid_middleware.modal_adapter.measurement.filename_utils` | RR `multichannel_filename_utils.py` |
| `pianoid_middleware.modal_adapter.measurement.calibration_validator` | RR `calibration_validator_v2.py` |
| `pianoid_middleware.modal_adapter.measurement.default_recorderConfig.json` | RR `recorderConfig.json` (Belarus default) |
| ~~`PianoidCore/sdl_audio_core/`~~ — RETIRED dev-4284 (ASIO session replaces it) | RR `sdl_audio_core/` |

> **Acquisition = ASIO measurement session (dev-4284, 2026-10-11).** Every measurement is
> one sample-locked `POST /audio/session` on the `:5000` backend: each configured exciter is
> driven ALONE (one scenario per exciter), all receivers + the loopback input are captured in
> the same `bufferSwitch`, and the capture is aligned on the measured electrical round trip.
> Details: [§ ASIO acquisition](#asio-acquisition-dev-4284).

The `_room_response_bootstrap.py` shim and the `PIANOID_ROOMRESPONSE_PATH`
env var have been deleted. `GET /modal/collect/health` now returns the
status of an in-tree import probe rather than a sibling-repo discovery
probe — the response shape is unchanged for frontend compatibility.

See [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md)
§ Phase 0 for the rationale.

## Architecture

```
 Tunner Collection subpanel ── REST /modal/measurements/* ──> modal_adapter_server (:5001)
                                                               routes -> MeasurementSession
                                                               (single active run, thread)
                                                                 one scenario per exciter:
                                                                 SingleScenarioCollector
                                                                   -> RoomResponseRecorder
                                                                      -> AudioIO (RemoteAudioIO)
                                                                             |
                     GET /audio/devices, POST /audio/session  <--------------+
                                                                             v
                                                    backendServer.py (:5000) — owns ASIO:
                                                    pause synthesis -> play_record -> resume
```

The collection engine sits in
`PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py` and
is wired into the existing `modal_bp` blueprint via
`collection_routes.register_collection_routes(modal_bp)`.

### Single-active-session constraint

Collection is exclusive — one run per process. The
`MeasurementSession` instance lives on `app.config['measurement_session']`
and tracks one in-flight run at a time:

| State | Meaning |
|-------|---------|
| `idle` | No active session |
| `recording` | RoomResponseRecorder + SingleScenarioCollector running (current exciter) |
| `saving` | Generating averaged_responses + measurements/ mirror (current exciter) |
| `done` | Success terminal |
| `cancelled` | Cancellation requested mid-flight |
| `error` | Recording or save failed (the message names the cause, e.g. `asio_unavailable`, `loopback_not_detected`) |

(`pausing` / `resuming` are no longer emitted — the backend's ASIO session pauses and
resumes synthesis itself.) A `start()` while another run is in flight raises
`CollectionConflictError` → HTTP 409; a failed ASIO pre-flight raises
`CollectionUnavailableError` → HTTP 503 `asio_unavailable` synchronously, before any folder
is created. Cancellation is signalled via `threading.Event` and checked between exciters.

## ASIO acquisition (dev-4284)

Proposal: [asio-audio-core-retire-sdl-2026-10-11.md](../../proposals/asio-audio-core-retire-sdl-2026-10-11.md)
(Phase 3). Session API: [REST_API — POST /audio/session](REST_API.md#post-audiosession),
[AUDIO_DRIVERS — ASIO measurement session](../pianoid-cuda/AUDIO_DRIVERS.md#asio-measurement-session-dev-1b6c).

| Concern | Owner / behaviour |
|---|---|
| Device + synthesis pause (P1) | `:5000` backend only (`audio_session.py`); the modal adapter never opens audio |
| Transport | `measurement/audio_io.py` — `RemoteAudioIO` (`PIANOID_BACKEND_URL`, default `http://127.0.0.1:5000`): signal → temp `.npy` (TEMP), session `out_dir` → temp, `data.npy` loaded then deleted; retries `409 session_in_progress` for 60 s |
| Errors | backend down / no ASIO host / no session API → `AudioIOUnavailable` (503 `asio_unavailable`); session abort / loopback missing → `AudioIOError` (ends the run with the reason) |
| `LocalAudioIO` | not implemented: the ASIO host only opens with the engine; an engine-free host is a later phase. With `:5000` down, collection / Setup Test / devices fail fast with 503 |

**`setup/audio_config.json` schema v2** (`modal_adapter/audio_setup.py`, applied on every
`read_setup_config` / `write_setup_config` / create / import):

```json
{
  "schema_version": 2, "backend": "asio",
  "exciters":  ["Out 1", "Out 2", "Out 3", "Out 4"],
  "receivers": ["In 1", "In 2", "In 3", "In 4", "In 5", "In 6", "In 7"],
  "loopback":  {"output": "Out 5", "input": "In 8", "mirror": false},
  "multichannel_config": {"enabled": true, "num_channels": 8,
                          "channel_names": ["In 1", "...", "In 8"],
                          "calibration_channel": 7, "loopback_channel": 7,
                          "reference_channel": 0, "response_channels": [0, 1, 2, 3, 4, 5, 6], "...": "..."}
}
```

- Channels are ASIO driver channel **names** (stable), never SDL ordinals.
- Recorded channel list = `receivers + [loopback.input]`; `num_channels` / `channel_names` /
  `loopback_channel` are **derived**; user roles (`calibration_channel`, `reference_channel`,
  `response_channels`) are kept while in range; defaults: calibration = loopback channel,
  responses = all receivers, reference = first response; the loopback channel is never a response.
- **v1 migration (old SDL setups).** `input_device*` / `output_device*` / `sdl_version` move to
  `legacy_sdl` (provenance only); `multichannel_config` is kept verbatim; the file on disk is
  NOT rewritten on read (a write stores v2). Imported SDL-era datasets map the same way; an
  ASIO-collected dataset's `recorder_config` (`exciters` / `input_channels` / `loopback`) maps
  back to roles. A legacy Measurement opens, analyses and branches unchanged; to collect into
  it, pick ASIO channels (after unlocking).

**Per-exciter collection.** `collect/start {scenario_number: N}` runs every configured exciter
**alone**: exciter *k* → scenario `N + k` (a scenario = one excitation point), each with
`num_measurements` sessions of `num_pulses` cycles. After each scenario the route's callback
`Measurement.record_scenario` updates `scenario_indices` (+ N4 auto-lock on the first).
Without exciters the run fails with `channels_not_configured`.

**Loopback reference (D4) and alignment.** Per session the loopback output carries a one-sample
marker at frame 0 followed by a 0.12 s lead before the drive; the marker onset on the loopback
input (the backend's own `audio_session.measure_loopback`) is the electrical round trip of that
session and the capture is shifted by it, so recording frame *n* = drive frame *n*. The
recorder therefore applies **no onset re-alignment** (`shift_applied: 0`); the reference
channel's acoustic onset is kept in metadata and the loopback channel's onset is a check
(≤ 1 sample) when it carries the drive (D7). Without a loopback the session compensates the
driver-reported latency and the legacy reference-onset alignment applies.

**Drive mirror (`loopback.mirror`, default off).** Measured on the rig 2026-10-11: a copy of
the drive on Out 5 leaks electrically into In 5–7 (onset 1 sample; early peak −37 / −42 /
−41 dBFS vs −41 / −50 / −51 dBFS acoustic). Data collection therefore sends the marker only;
a calibration-mode capture (Setup Test) whose calibration channel is the loopback channel turns
the mirror on for that diagnostic session so the calibration channel carries the drive.

**Metadata.** `session_metadata.json` → `device_info` = ASIO snapshot + channel roles
(`get_audio_info`); each measurement's `recording_stats.audio_session` = `{session_id, exciter,
outputs, mirror, start_sample_position, xruns, alignment, loopback{onset_frames, ...}, latency,
levels, noise_floor_dbfs}`. Setup Test's silence criterion uses the session's pre-roll noise
floor (the aligned capture starts at the impulse).

**Rig acceptance (2026-10-11, UMC1820, via the Tunner UI + REST, live `:5000` on ASIO).**
Measurement `ASIO-rig-2026-10-11b`: exciters Out 1–4, receivers In 1–7, loopback Out 5 → In 8.
4 scenarios × 5 measurements: every session drove exactly `[Out k, Out 5]`; loopback onset
**328 frames in all 20 sessions (spread 0)**; 0 xruns; receiver acoustic onsets identical across
repeats; `averaged_responses` 8 ch; manifest `scenario_indices [0..3]` + auto-lock. Project
`ASIO-rig-2026-10-11b_p1` → ESPRIT 200 in 64 s: 124 / 137 / 133 / 128 modes per scenario.
Legacy `LG` (SDL v1 setup, 159 scenarios) and `LG_p1` still open. (The round trip read 328
frames on 2026-10-11 afternoon vs 334–335 in the morning probe — constant within a stack run.)

## Excitation types — impulse train vs chirp (dev-fd69)

`setup/impulse_config.json` → `excitation_type` selects the data-collection drive
(`measurement/chirp_excitation.py`; Tunner Impulse section selector):

| `excitation_type` | Drive | Per-measurement IR | Use |
|---|---|---|---|
| `"impulse"` (also: field **absent** — every Measurement created before dev-fd69) | pulse train (`num_pulses` × `cycle_duration`, `impulse_form`, `volume`) | cycle average, `cycle_duration` long (e.g. 100 ms at 10 Hz) | impulse hammer / striker setups |
| `"chirp"` (default for **new** Measurements) | exponential sine sweep `chirp.{f_start_hz 20, f_stop_hz 10000, duration_s auto, level_dbfs −30}` | ESS deconvolution, `chirp.ir_length_ms` (default 1000 ms) long, harmonic distortion separated (it lands at negative time) | transducers attached to the board (voice-coil exciters) |

- `duration_s: null` = the shortest sweep whose 2nd-harmonic IR (advance `T ln2 / ln(f2/f1)`) cannot
  overlap the IR (`ess.min_sweep_s`, ≥ 4 s; 9.87 s for 1 s over 20 Hz–10 kHz); an explicit shorter
  value is refused. Level policy as everywhere: > −20 dBFS warns, > −12 dBFS refused.
- The chirp IR replaces the averaged pulse cycle 1:1 (`room_response` = `impulse` = IR, t = 0 = drive
  start on the loopback-aligned capture, shift 0) → `averaged_responses/`, `measurements/scenario_N.npy`
  and the ESPRIT pipeline are unchanged and finally get IRs as long as the band configs' 400–600 ms
  `ir_length_ms`. The IR is response per unit drive (deconvolved), not a raw recording.
- The **Setup Test** (`mode='calibration'`) always drives the pulse train — it validates the rig wiring.
- Per-measurement `recording_stats.audio_session.chirp` = config + harmonic levels (dB re linear IR, per
  channel). Appends to an existing scenario refuse a config whose `excitation_type` / `chirp` differs
  (`dataset_collector._config_compatible`; absent = impulse).

## Swept-sine discovery, PolyMAX and method comparison (dev-69fd / dev-fd69)

Acquisition + identification paths that use **only** the ASIO session (`POST /audio/session`),
independent of `RoomResponseRecorder` / `MeasurementSession`. CLI only (no UI yet). Results and the
rig evaluation: [modal-methods-attached-exciters-2026-10-11.md](../../development/modal-methods-attached-exciters-2026-10-11.md);
swept design + defaults: [swept-sine-mode-discovery-2026-10-11.md](../../proposals/swept-sine-mode-discovery-2026-10-11.md).

```
python -m pianoid_middleware.modal_adapter.swept_discovery run   [--level-dbfs -30] [--coarse-s 8]
        [--fine-s 1] [--fine-rate HZ_PER_S] [--fine-gap-tau 5] [--fine-gap-max 2] [--repeat-fine 3]
python -m pianoid_middleware.modal_adapter.swept_discovery synth                 # offline plant
python -m pianoid_middleware.modal_adapter.polymax <swept run dir | coarse_frf.npz> [--loo]
python -m pianoid_middleware.modal_adapter.swept_discovery.rig_checks {linearity|crosstalk|sweep_speed}
python -m pianoid_middleware.modal_adapter.appropriation {table|dwell} <modes.npz> [...]
```

**Swept discovery** (`swept_discovery/`): noise record → per exciter a coarse ESS (20 Hz–10 kHz,
`--coarse-s` 8 s, −30 dBFS) → deconvolved FRF H (F × 7 receivers × 4 exciters, 0.25 Hz grid) → CMIF
σ1/σ2 peaks → zones → fine narrow linear sweeps per zone (`--fine-s` minimum duration, `--fine-rate`
caps the sweep rate so wide zones sweep slower, decay gap `--fine-gap-tau` time constants ≤
`--fine-gap-max` s) → polyreference rational fit per zone. `report.json` carries `sweep_rate`: the
quasi-stationarity index r/(πB²) of the coarse ESS at every peak and of every fine zone sweep
(< 0.1 quasi-stationary; deconvolution makes the FRF exact for an LTI system at any rate — the index
matters for nonlinearity / time variance and per-Hz energy).

| File | Role |
|---|---|
| `audio_io.py` | `SessionAudioIO` = adapter over the modal adapter's single session client `measurement/audio_io.RemoteAudioIO` (marker-only loopback); every session persisted ALIGNED under `sessions/<tag>/` (`data.npy`, `signal.npy`, `meta.json`); a tag can be used once per run (`SessionTagReused`) · `SimulatedPlantIO` |
| `procedure.py` | `DiscoveryConfig`, coarse / fine passes; repeat passes use their own tags `repeat{r}_fine_e{e}_s{s}` (dev-69fd's repeatability pass re-used `fine_e{e}_s1` and overwrote the main fine data of runs `20261011-rig1..3`) |
| `signals.py` · `frf.py` · `zones.py` · `fit.py` · `report.py` | sweeps + sweep-rate helpers · FRF · CMIF zones · rational fit · outputs (ESS itself: `measurement/ess.py`, shared with the chirp collection) |
| `rig_checks.py` | ESS harmonic distortion vs noise, repeat coherence `|mean H|²/mean|H|²`, level linearity (FRF deviation per band), early-arrival + unconnected-output crosstalk, sweep-speed SNR / deviation / σ2/σ1; live `run_*` procedures |

**PolyMAX** (`polymax/`): poly-reference LSCF on the measured FRF tensor, per overlapping band
(`band_edges` 30/60/120/250/500/1k/2k/4k/9.5k Hz, ±15 % overlap, each band owns its core).

| Stage | Method · defaults |
|---|---|
| poles + MPFs | right matrix-fraction model in z = e^{j(ω−ω_c)Δt} (band shifted to its centre, complex coefficients — no conjugate poles needed in a band), per-output normal equations reduced to the denominator, monic α_p = I, block companion → poles λ and modal participation factors; orders 2..`p_max` 40 (p · 4 poles at order p) from ONE assembly; weights 1/noise rms |
| stabilization | vs order p−1: f within 1 %, ζ within 10 %, MAC(MPF) ≥ 0.9 |
| selection | reference order with the most poles that have a match (f + ζ + MPF) in ≥ 30 % of the other orders; poles of one order are distinct, so close modes are never merged |
| residues | LSFD on the selected poles (conjugate terms + 4 real residual terms), backward parsimony pruning (a pole whose removal grows the local misfit < 20 %, or < 10 dB above a pure-noise pole's share, is dropped) |
| outputs | `modes.npz` (swept / ESPRIT per-scenario format: residue column per exciter, per-exciter SNR), `report.json` (stability, MPC, rank-1 ratio σ2/σ1 of the residue, MAC(MPF, residue participation), CMIF level, fit residual), `stabilization.png`; `--loo` = leave-one-exciter-out fits |

**Force appropriation** (`appropriation/`): per identified mode, exciter weights for a sine at f_m
that maximise the mode's share of the modal energy (generalized Rayleigh quotient on the PolyMAX /
swept modal model; real signed or complex; or `|uᴴHw|²/‖Hw‖²` on a measured FRF; MMIF), scaled to
−24 dBFS. `appropriation table <modes.npz> [--real]` → `appropriation_table.json` +
`actuator_feed.npz` (W exciters × modes, real signed, unit max per mode = the per-mode actuator
drive pattern, decka semantics). `appropriation dwell <modes.npz> --modes f1,f2 [--single]
[--current-inputs ...]` drives all exciters at once (`SessionAudioIO.play_record_multi`), dwells
≥ 6τ, switches off and fits the free decay through a modal filter → model-free f_n and ζ; optional
current-sense inputs = force reference.

**Comparison** (`modal_adapter/mode_comparison.py`): the cross-exciter / cross-method metrics of the
2026-10-11 consistency analysis as a module — mutual-nearest-neighbour matching within half the mean
half-power half-width, chance level by ±2/3 % frequency shifts, clusters found by 1..G groups, f / ζ
spread and shape MAC per band, chance MAC, collapsed cross-method agreement; loaders for `modes.npz`
and ESPRIT result folders.

## Output File Layout

Every scenario writes the full RoomResponse hierarchy into
`{project_dir}/{scenario_name}/`, where
`scenario_name = "{computer}-Scenario{N}-{room}"` (default
`ModalAdapter-ScenarioN-Run`):

```
{project_dir}/
  {computer}-ScenarioN-{room}/
    raw_recordings/        *.wav  (one per measurement)
    impulse_responses/     *.wav, *.npy (one per measurement, per channel)
    room_responses/        *.wav  (averaged room response per measurement)
    averaged_responses/    average_chN.npy  (per-channel mean IR — generated post-collection)
    metadata/
      session_metadata.json
    analysis/              (reserved)
  measurements/
    scenario_N.npy         (mirror of averaged responses, shape (samples, n_channels))
```

The `measurements/scenario_N.npy` mirror exists for compatibility with
the existing `ModalAdapter._discover_npy_scenarios` consumer
(`modal_adapter.py:1348+`). The hierarchical RoomResponse layout is
also already supported by `_discover_roomresponse_scenarios`
(`modal_adapter.py:1244-1346`) — both consumer paths see the same data.

## REST API

### v1 surface — RETIRED at Phase 2a (dev-msmtui, 2026-05-11)

All six legacy endpoints under `/modal/collect/*` were retired to **HTTP
410 Gone** in the same commit that wired the real Setup Test backend
(Phase 2a). Per proposal §3.4 (N8 hard cutover policy), no compatibility
wrappers are maintained — clients that still call these paths receive
the structured 410 body below and must migrate.

| Method | Retired path | Replacement |
|--------|--------------|-------------|
| GET    | `/modal/collect/health`           | None — health is reflected by import-time logs from the modal_adapter_server (the in-tree measurement stack imports at process start). |
| POST   | `/modal/collect/start`            | `POST /modal/measurements/<id>/collect/start` (Phase 2c) |
| GET    | `/modal/collect/status`           | `GET /modal/measurements/active_session` (Phase 2a — global probe, the single legacy survivor) |
| POST   | `/modal/collect/cancel`           | `POST /modal/measurements/<id>/collect/cancel` (Phase 2c) |
| GET    | `/modal/collect/results/<sid>`    | `GET /modal/measurements/<id>/collect/results/<sid>` (Phase 2c) |
| GET    | `/modal/collect/devices`          | `GET /modal/measurements/<id>/devices` (Phase 2c) — per-Measurement; an unscoped `/modal/measurements/devices` alias is planned for the Create-Measurement flow |

Every retired path returns the standard 410 body:

```json
{
  "error": "endpoint_retired",
  "retired_at": "v2",
  "phase": "Phase 2a",
  "replacement": "/modal/measurements/<id>/collect/start",
  "doc": "docs/proposals/modal-adapter-measurement-entity-2026-05-10.md#34-endpoints-removed--hard-cutover-at-phase-2-n8"
}
```

### v2 surface — Measurement-entity

See [Phase 1 — Measurement Entity](#phase-1--measurement-entity-dev-msmt-2026-05-11)
below for the `/modal/measurements/*` REST surface (Phase 1 shipped the
endpoints; Phase 2a (this commit) wires the Setup Test endpoint to its
real implementation; Phase 2c will ship the per-Measurement
`/collect/*` family).

## Recorder Configuration Overrides (v1)

Per user direction Q2, only the high-impact keys are accepted in v1.
All others fall back to the vendored
`pianoid_middleware/modal_adapter/measurement/default_recorderConfig.json`
(Phase 0 RR-port, dev-rrport 2026-05-10 — was previously read from
`D:/repos/RoomResponse/recorderConfig.json`).

| Override key | Type | Effect |
|---|---|---|
| `sample_rate` | int | Audio sample rate (Hz) |
| `num_pulses` | int | Pulses per recording cycle |
| `volume` | float (0..1) | Output volume scale |
| `impulse_form`, `pulse_duration`, `pulse_fade`, `pulse_frequency`, `cycle_duration`, `series_config` | — | Stitched from the Measurement's impulse / series setup (dev-4284: these were dropped by the whitelist before, so collection silently used the bundled defaults) |
| `exciters` / `input_channels` / `loopback` | list / list / object | ASIO channel roles (names) from `audio_config` v2; the engine adds `active_exciter` per scenario |
| `multichannel_config` | object | Channel roles (`response_channels`, `calibration_channel`, `reference_channel`) and `enabled` flag |
| `num_measurements` | int | Pulses per scenario (default 5) |
| `measurement_interval` | float | Seconds between measurements (default 0.5) |
| `description`, `computer`, `room` | str | Folder-naming + metadata |

Full schema viewer (every recorderConfig.json key) is deferred to Wave B-2.

## Curl-Only End-to-End Example (Phase 2a — Setup Test wired)

```bash
# 1. List measurements (Phase 1)
curl http://127.0.0.1:5001/modal/measurements
# {"measurements":[...]}

# 2. Create a Measurement (Phase 1)
curl -X POST http://127.0.0.1:5001/modal/measurements \
  -H "Content-Type: application/json" \
  -d '{"measurement_id":"Belarus-2026-05-11"}'

# 3. Configure the audio + impulse + series setup (Phase 1)
curl -X PATCH http://127.0.0.1:5001/modal/measurements/Belarus-2026-05-11/audio_config \
  -H "Content-Type: application/json" \
  -d '{"sample_rate":48000,"input_device":-1,"output_device":-1,
       "multichannel_config":{"enabled":true,"num_channels":6,
         "calibration_channel":0,"reference_channel":1,
         "response_channels":[2,3,4,5]}}'

# 4. Run Setup Test (Phase 2a — real wiring)
curl -X POST http://127.0.0.1:5001/modal/measurements/Belarus-2026-05-11/setup_test
# {"overall":"pass","schema_version":1,"tested_at":"2026-05-11T15:00:00Z",
#  "results":[...],"recording_path":"setup_test/latest.wav","error":null}

# 5. Poll the global active-session probe to follow Setup Test progress
curl http://127.0.0.1:5001/modal/measurements/active_session
# {"phase":"done","measurement_id":"Belarus-2026-05-11",
#  "session_id":"setup-test-12345678",
#  "messages":[{"ts":"...","level":"info","src":"setup_test",
#               "msg":"Starting Setup Test cycle"}, ...]}

# 6. Start a real scenario (Phase 2c — NOT YET SHIPPED at Phase 2a)
# curl -X POST http://127.0.0.1:5001/modal/measurements/Belarus-2026-05-11/collect/start ...
```

The v1 example below is preserved for archive only — every endpoint
in it now returns 410 Gone.

<details>
<summary>Legacy v1 curl flow — RETIRED at Phase 2a (returns 410)</summary>

```bash
# Each of these returns HTTP 410 with a structured body since Phase 2a:
curl http://127.0.0.1:5001/modal/collect/health         # 410 Gone
curl http://127.0.0.1:5001/modal/collect/devices        # 410 Gone (use /modal/measurements/<id>/devices)
curl -X POST http://127.0.0.1:5001/modal/collect/start  # 410 Gone (use /modal/measurements/<id>/collect/start)
curl http://127.0.0.1:5001/modal/collect/status         # 410 Gone (use /modal/measurements/active_session)
curl http://127.0.0.1:5001/modal/collect/results/abc    # 410 Gone (use /modal/measurements/<id>/collect/results/<sid>)
curl -X POST http://127.0.0.1:5001/modal/collect/cancel # 410 Gone (use /modal/measurements/<id>/collect/cancel)
```
</details>

## Phase 1 — Measurement Entity (dev-msmt, 2026-05-11)

**Status:** Phase 1 of the Modal Adapter Measurement-entity refactor
landed on PianoidCore `feature/dev-msmt-phase1-measurement-entity`.
See the proposal §1–§5 + §6 Phase 1 for the authoritative spec:
[`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md).

Phase 1 promotes **Measurement** to a first-class backend entity. The
legacy `/modal/collect/*` surface (Wave B-1, documented above) is
**kept alive during the Phase 1 transition window** per N8 — Phase 2
ships the frontend cutover and deletes it with 410 Gone wrappers.

### Measurement Entity Surface

Four new modules under `pianoid_middleware.modal_adapter`:

| File | Purpose |
|------|---------|
| `measurement_entity.py` | `Measurement` dataclass + JSON schemas (manifest + 5 setup files) + slug normalisation (N1) + lock semantics (N4) |
| `measurement_catalog.py` | `MeasurementCatalog` — list / lookup / create / delete with reverse-project-lookup (N6) |
| `measurement_routes.py` | 12 REST endpoints under `/modal/measurements/*` |
| `migrate_to_measurement_entity.py` | v1->v2 migration CLI (dry-run / apply / verify / rollback) with per-project rollback tarballs |

Filesystem layout (per proposal §2.2):

```
{measurements_base}/             # default D:\modal_measurements, override via $PIANOID_MEASUREMENTS_DIR
  {measurement_id}/              # = globally unique display name (N1)
    measurement.json             # manifest
    setup/
      audio_config.json
      impulse_config.json
      series_config.json
      mapping_config.json
      calibration_criteria.json
    scenarios/
      {scenario_name}/           # e.g. PlyWood-Scenario0-Take1
        raw_recordings/
        impulse_responses/
        averaged_responses/
        room_responses/
        metadata/
    setup_test/
      latest.json                # N3 — single-latest, overwritten per run
      latest.wav
    locks/
      acquisition.lock           # N4 — auto-written after first scenario
```

Project entity gains four new fields in v2 schema (`schema_version: 2`):
- `measurement_id` — parent Measurement (N1 unique name)
- `measurement_path` — absolute path (cross-machine portability per N2)
- `measurement_snapshot` — deep-copy of parent's setup at branch time (N5 — frozen)
- `averaging` — `ir_working_length_ms`, `ir_fade_length_ms`, `force_reaverage`, `qc_threshold`

### REST Endpoints

**Measurement entity (new in Phase 1, port 5001):**

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/modal/measurements`                                      | Create new Measurement. Body: `{measurement_id, sample_rate?, audio_config?, impulse_config?, series_config?, mapping_config?, calibration_criteria?}`. Returns 201 + summary. 409 on duplicate (N1), 422 invalid slug |
| GET    | `/modal/measurements`                                      | List all Measurement summaries |
| GET    | `/modal/measurements/<id>`                                 | Full manifest + inline setup/* + scenarios list. 404 if missing |
| PATCH  | `/modal/measurements/<id>/audio_config`                    | Update audio_config (423 Locked if `acquisition.lock` exists per N4) |
| PATCH  | `/modal/measurements/<id>/impulse_config`                  | Same (423 if locked) |
| PATCH  | `/modal/measurements/<id>/series_config`                   | Same (423 if locked) |
| PATCH  | `/modal/measurements/<id>/mapping_config`                  | Same (423 if locked) |
| PATCH  | `/modal/measurements/<id>/calibration_criteria`            | Always allowed even when locked (analysis-time gate per N4) |
| POST   | `/modal/measurements/<id>/setup_test`                      | Run Setup Test — wired through `SetupTestEngine` (Phase 2a, dev-msmtui, 2026-05-11). Pauses synth, captures one calibration cycle, validates against `setup/calibration_criteria.json`, overwrites `setup_test/latest.*` per N3. 502 on pause failure, 500 on engine crash. |
| GET    | `/modal/measurements/<id>/setup_test`                      | Fetch latest Setup Test report (404 if never run) |
| POST   | `/modal/measurements/<id>/unlock`                          | Manual unlock-with-warning per N4. Body: `{confirm: true}` required. 400 without confirm |
| DELETE | `/modal/measurements/<id>`                                 | Delete. 409 with `{linked_projects: [...]}` if any Project references this Measurement (N6, no force flag). Server-side cost = `shutil.rmtree(path)` + cross-project ref scan (both fast on isolation; the rmtree of a 8.8 GB / 2526-file fake measurement clocked 1.66 s in dev-msdel-3b1a 2026-05-25 timing). |

**Frontend timeout note.** The `useMeasurementCatalog.deleteMeasurement` axios call uses a **60 s timeout** (`PianoidTunner/src/hooks/useMeasurementCatalog.js`). Two factors compound on the budget: (a) Windows `rmtree` on a many-scenario folder, and (b) `modal_adapter_server.py` runs `app.run(threaded=False)` for CuPy-GPU thread-pinning, so DELETE serialises behind any in-flight FRF (~22 s), modal-mass, or ESPRIT request. The original 5 s budget shipped with `dev-maimport` round 14 was unsurvivable when the user happened to delete during one of those long ops. Sibling pattern: `useMeasurementCatalog.renameMeasurement` uses 30 s for similar rationale.

**Project endpoints (Phase 1 additions):**

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/modal/projects`                                          | v2 Create — body `{name, measurement_id, band_config?, async?}`. Snapshots parent's setup at create time per N5. URL-param `?measurement=<id>` is an alternative. 404 unknown measurement, 409 name collision. **Async opt-in:** body `{"async": true}` returns 202 + `{operation_id, status_url}`; the canonical averager runs in a background thread and progress is polled via `GET /modal/import_operations/<op_id>/status` until a terminal phase (`done` / `error` / `cancelled`). Cancel via `POST /modal/import_operations/<op_id>/cancel` (cooperative, at scenario boundaries). See round-30 doc gap heads-up below. |
| POST   | `/modal/projects/<old>/branch`                             | Branch sibling Project — body `{new_name, inherit_band_config?}`. Snapshots parent at branch time (can differ from source if parent was unlocked+edited). 409 if source is v1 (no measurement_id) |

**Existing project endpoints unchanged** during Phase 1: `/modal/projects/create`, `/modal/projects/open`, `/modal/projects/copy`, `/modal/projects/delete`, `/modal/projects/<n>/rename`, `/modal/projects/<n>/reaverage`, etc.

**Frontend timeout note (async create path).** `CreateProjectFromMeasurementDialog.jsx` consumes the async path and uses a **60-min `POLL_MAX_MS`** wall-clock backstop on its inline await-loop (`PianoidTunner/src/components/CreateProjectFromMeasurementDialog.jsx`). The cap is a defensive backstop, NOT a backend deadline — the backend worker keeps running regardless of client disconnects. When the cap fires the dialog's error message tells the user the operation may still be running and to refresh the project list. The original 5-min budget shipped with `dev-maimport` round 30 was hit by a real large measurement (`dev-cptmto-9d7e`, 2026-05-25). UX features added alongside the bump: live mm:ss elapsed-time chip below the LinearProgress, plus a "still running" Alert that appears past 10 min elapsed. Cancel remains the primary user escape (Cancel button is enabled the whole time; cooperative-cancels via `POST /modal/import_operations/<op_id>/cancel`).

### Migration Script

```bash
# Dry-run (default) — print plan, no writes
python -m pianoid_middleware.modal_adapter.migrate_to_measurement_entity \
    --mode dry-run \
    [--projects-base D:\modal_projects] \
    [--measurements-base D:\modal_measurements] \
    [--project NAME]  # repeatable; default = all projects

# Apply — write rollback tarball, upgrade Measurement layout in-place, upgrade project.json to v2
python -m ... --mode apply

# Verify — confirm v2 invariants hold
python -m ... --mode verify

# Rollback — restore project.json + modal_adapter/ from tarball
python -m ... --mode rollback --project NAME
```

The migrator refuses to touch:
- Projects already at `schema_version: 2` (status=`already_v2`)
- v1 projects with no `measurement_source` (status=`will_skip`)
- v1 projects whose `measurement_source` points outside `measurements_base` (status=`will_skip` — never modifies external paths)
- v1 projects whose `measurement_source` directory does not exist (status=`will_skip`)

Status codes from `--mode apply`: exits 0 on success-only; exits 1 if any project errored.

### Setup Test (Phase 2a — real wiring, dev-msmtui, 2026-05-11)

Phase 1 shipped the endpoint surface only (`overall: "not_implemented"`).
Phase 2a (this commit) replaces the stub with the real implementation:
`SetupTestEngine` in
`pianoid_middleware/modal_adapter/setup_test_engine.py`.

Flow on `POST /modal/measurements/<id>/setup_test`:

1. ASIO pre-flight (`GET /audio/devices` on `:5000`). No host → **503**
   `asio_unavailable` (dev-4284; formerly a `/pause_synthesis` 502).
2. Stitch the Measurement's `setup/{audio,impulse,series,mapping}_config.json`
   into a single recorder cfg via `build_recorder_config()`.
3. Construct `RoomResponseRecorder` (in-tree port from Phase 0) and
   invoke `take_record(mode='calibration', save_files=False)` for one
   calibration cycle — one ASIO session driving the FIRST exciter (the
   backend pauses / resumes synthesis) — NO scenario folder, NO averaging,
   NO N4 auto-lock.
4. Evaluate each `setup/calibration_criteria.json` entry against the
   measured signal. The default 5 criteria each dispatch to a
   per-criterion measurement function (`_measure_for_criterion`) and
   per-criterion comparison (`_criterion_passes` — `>=` for "_min"
   criteria, `<=` for "_max" criteria). Criteria whose target channels
   aren't configured surface as `verdict: "not_applicable"` and don't
   escalate the overall.
5. Reduce: `overall = fail` if any `fail_action="fail"` criterion failed;
   else `warn` if any `fail_action="warn"` failed; else `pass`.
6. Write the report to `setup_test/latest.json` and the calibration
   channel as mono 16-bit PCM to `setup_test/latest.wav` (N3 overwrite).

Report shape (proposal §2.5 lines 512-535):

```json
{
  "schema_version": 1,
  "tested_at": "2026-05-11T15:00:00Z",
  "overall": "pass",                          
  "results": [
    {
      "criterion_id": "calibration_correlation_min",
      "channel": "calibration",
      "measured": 0.92,
      "threshold": 0.85,
      "verdict": "pass",
      "fail_action": "fail"
    }
  ],
  "recording_path": "setup_test/latest.wav",
  "error": null
}
```

The `error` field is only populated if the engine itself crashed
(recorder import failure, missing multichannel config, etc.) — in that
case `overall = "fail"` and the report is still persisted so the UI
sees the same surface as a "real" fail.

### Streaming progress messages (Phase 2a — Q8)

`MeasurementSession` carries a `messages: List[Dict]` ring buffer (cap
100, FIFO eviction) and an `emit_message(level, src, msg)` thread-safe
appender. Lifecycle messages are emitted at every phase transition by
both the regular session (pausing → recording → saving → resuming →
done/error/cancelled) and the Setup Test engine (Starting → Pause OK →
Invoking recorder → Setup Test complete -> overall=...). Messages are
surfaced via:

```
GET /modal/measurements/active_session
```

returning the snapshot (phase, measurement_id, session_id,
progress_pct, started_at, finished_at, error_message, output_paths,
messages). Used by the Phase 2b `<CollectionLog>` frontend component
to render a rolling log.

When idle: `{phase: "idle", measurement_id: null, session_id: null, messages: []}`.

### Locks and N4

- Auto-lock after first successful scenario (`record_scenario` writes `locks/acquisition.lock` if `num_scenarios` transitions 0->1)
- Migrated Measurements are sealed at apply time (`reason: "migration_v1_to_v2"` in the lock body) — re-collection requires explicit unlock
- `setup/*` writes are rejected with `MeasurementLockedError` -> 423 Locked
- `setup/calibration_criteria.json` is exempt (analysis-time gate)
- `POST /unlock {confirm: true}` is always available; lock auto-fires again on the next successful scenario

### Cross-Links

- Proposal: [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md) — authoritative spec, all 16 decisions baked in
- Tests (Phase 1 baseline): 133 cases across `tests/unit/test_measurement_entity.py` (56), `tests/unit/test_measurement_catalog.py` (22), `tests/integration/test_measurement_routes.py` (25), `tests/integration/test_project_v2_branch.py` (13), `tests/integration/test_migration_to_measurement.py` (17)
- Tests (Phase 2a additions, dev-msmtui): +28 cases (test_measurement_routes.py setup_test class expanded from 4 stub tests to 8 real-wiring tests; +20 cases in new `tests/integration/test_setup_test_engine.py`; +8 cases in new `tests/integration/test_v1_collect_410.py`; `test_modal_collection_b1.py` refactored from 10 v1-HTTP tests to 11 direct MeasurementSession tests including 2 new streaming-message tests). Net Phase 2a total: 68 integration tests in the measurement collection + setup-test surface, all green.

## Phase 2a Backend Cutover (dev-msmtui, 2026-05-11)

**Status:** Phase 2a of the Modal Adapter Measurement-entity refactor
landed on PianoidCore `feature/dev-msmtui-phase2a-backend-cutover`.
See proposal §6 Phase 2 + §2.5 + §3.4 for the authoritative spec:
[`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md).

What landed:

1. **Setup Test wired end-to-end** — see [§ Setup Test (Phase 2a)](#setup-test-phase-2a--real-wiring-dev-msmtui-2026-05-11)
   above. New module `setup_test_engine.py` (~840 LOC) owns the
   one-shot calibration capture + criteria reduction.
2. **v1 `/modal/collect/*` hard cutover to 410 Gone** — see [§ v1 surface
   — RETIRED at Phase 2a](#v1-surface--retired-at-phase-2a-dev-msmtui-2026-05-11)
   above. Six legacy endpoints retired; the single survivor is the
   global `GET /modal/measurements/active_session` probe.
3. **Streaming progress messages (Q8)** — see [§ Streaming progress
   messages](#streaming-progress-messages-phase-2a--q8) above.
   `MeasurementSession._SessionState` carries a `messages` ring buffer
   (cap 100) populated by `emit_message()` at every lifecycle phase
   transition. Surfaced verbatim via the active_session probe.
4. **MeasurementSession.start accepts `measurement_id`** — sets the
   `_SessionState.measurement_id` so the global probe can route the UI
   to the parent Measurement when a session is in flight.

What's NOT yet landed (Phase 2b/2c — outdated, see Phase 2c section below):

- Frontend Collection subpanel (5 sections + shared `<SetupTest>` +
  Unlock-with-warning + `<CollectionLog>` — Phase 2b). **Done at Phase 2b.**
- Per-Measurement collection endpoints `/modal/measurements/<id>/collect/*`
  (start/cancel/status/results/devices — Phase 2c). **Done at Phase 2c.**
- Retirement of `/modal/projects/copy` and `/modal/projects/create_from_zip`
  (depends on the Phase 2b frontend branch flow — Phase 2c). **Done at Phase 2c.**

## Phase 2c Per-Measurement Collect Endpoints (dev-msmtui-fc, 2026-05-11)

Five new acquisition endpoints + two device-enumeration endpoints landed
on top of Phase 1's `/modal/measurements/*` surface:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/modal/measurements/<id>/collect/start` | Start a single scenario session |
| GET  | `/modal/measurements/<id>/collect/status` | Per-Measurement session snapshot incl. `messages` ring buffer |
| POST | `/modal/measurements/<id>/collect/cancel` | Cancel in-flight scenario |
| GET  | `/modal/measurements/<id>/collect/results/<sid>` | Fetch completed scenario result |
| GET  | `/modal/measurements/<id>/devices` | ASIO channel tables (proxy of `:5000` `GET /audio/devices`) + the Measurement's current channel roles |
| GET  | `/modal/measurements/devices` | Unscoped alias for the Create-Measurement flow (no measurement_id yet) |

All five collect routes are Measurement-scoped: cross-Measurement
status reads return `{phase: "idle"}` (the Measurement looks idle from
its perspective even when a session is active on a different
Measurement). Cross-Measurement cancel returns 409 with the active
Measurement id. Cross-Measurement results lookup returns 404.

### Setup file → recorder_config stitching

The `MeasurementSession.start()` API takes a flat
`recorder_config_overrides` dict in the legacy recorder schema. The new
endpoints stitch the Phase 2 `setup/audio_config.json` +
`setup/impulse_config.json` + `setup/series_config.json` files into the
legacy schema via `_build_recorder_config_from_measurement(measurement)`
in `collection_engine.py`. Unit conversions handled there:

| Phase 2 setup field (ms) | Legacy recorder_config (s) |
|---|---|
| `impulse_config.pulse_duration_ms` | `pulse_duration` (×0.001) |
| `impulse_config.pulse_fade_ms` | `pulse_fade` (×0.001) |
| `series_config.cycle_duration_ms` | `cycle_duration` (×0.001) |

Other fields pass through unchanged (units already match):
`audio_config.input_device` → `input_device`, `series_config.num_pulses` →
`num_pulses`, etc. The `multichannel_config` block is deep-copied to
prevent caller-mutation back-leak.

**`volume` (dev-impulse-chart, 2026-05-12).** Relocated from
`series_config.json` to `impulse_config.json`. The stitcher reads
`impulse_config.volume` first; if absent (pre-relocation Measurement),
it falls back to `series_config.volume`. Frontend ImpulseSection
implements the same precedence so the field surfaces correctly for
legacy configs, and writes only to impulse_config — the migration
happens on the next user-driven Save.

**`recording_mode` removed (dev-impulse-chart, 2026-05-12).** The
field was previously surfaced from `series_config` into the recorder
cfg. After removal, the stitcher silently ignores it on legacy
configs — real acquisition is always `"standard"`. SetupTestEngine
continues to invoke `recorder.take_record(mode='calibration', ...)`
directly; that internal constant is unaffected.

The `voice_coil_config` sub-block in `setup/impulse_config.json` is
forward-looking — the current in-tree recorder does not consume it
(voice_coil-mode parameters are hardcoded). The stitching helper reads
it but does not propagate; if/when the recorder gains
`voice_coil_config` support, extend the helper. The Impulse-section
ECharts preview (`ImpulseShapeChart.jsx`) currently renders the
recorder's actual voice_coil formula (square pulse + simple ramp
pull-back), NOT the spec sub-block — when the recorder catches up
with the spec, the chart needs an update in lock-step.

### Per-call overrides

The endpoint handler layers any caller-supplied
`recorder_config_overrides` field ON TOP of the stitched setup, so a
per-scenario override still wins. Per-scenario metadata fields
(`description`, `computer`, `room`) are read from the request body —
they don't live in `setup/*` (which is per-Measurement). Defaults:
`room=measurement_id`, `description="Measurement {id} scenario {N}"`.

### Single-active rule + auto-lock (N4)

`MeasurementSession` enforces a single-active session per process (the
audio device is exclusive). A second `/collect/start` while a session
is in flight returns 409 with `code=session_in_flight`. On the FIRST
successful scenario completion of an unlocked Measurement,
`acquisition.lock` auto-fires (N4 — handled by the session's finalize
step, out of scope for the route itself).

### Devices endpoints

`GET /modal/measurements/<id>/devices` returns (dev-4284; proxy of the `:5000`
backend's `GET /audio/devices`):

```json
{
    "backend": "asio", "driver": "UMC ASIO Driver", "sample_rate": 48000.0, "buffer_size": 64,
    "latency": {"input_frames": 136, "output_frames": 168, "reported_roundtrip_frames": 304},
    "inputs":  [{"index": 0, "name": "In 1", "type": "Int32LSB", "supported": true}, "..."],
    "outputs": [{"index": 0, "name": "Out 1", "type": "Int32LSB", "supported": true}, "..."],
    "engine": {"loaded": true, "lifecycle_state": "PLAYBACK_ACTIVE", "...": "..."},
    "current": {"exciters": ["Out 1"], "receivers": ["In 1"], "loopback": {"output": "Out 5",
                "input": "In 8", "mirror": false}, "legacy_sdl": null}
}
```

`current` echoes the Measurement's channel roles (incl. `legacy_sdl` provenance of an old SDL
setup) for the Tunner Audio Devices pickers; the unscoped alias returns `current: null`.
No ASIO host on `:5000` → **503** `code=asio_unavailable`.

### routes.py C4 split (Phase 2c)

The monolithic `routes.py` (1842 LOC, C4-RED) was split into a
`routes/` package per proposal Phase 2c § routes.py split. Now:

| Module | LOC | Concern |
|---|---|---|
| `routes/__init__.py` | 148 | Blueprint + register_*_routes calls + 2 survivor routes |
| `routes/_helpers.py` | 129 | Shared helpers (get_adapter, get_pianoid, error_response, ...) |
| `routes/project_routes.py` | 547 | /projects/* family + 410 Gone for /copy + /create_from_zip |
| `routes/preset_routes.py` | 107 | /band_presets/* |
| `routes/build_routes.py` | 112 | /data_status, /project_state, /gpu_status, /status, /defaults |
| `routes/chains_routes.py` | 296 | /chains/* + /stabilization_diagram + /grid_heatmap + /mode_shape + /mode_preview + /channel_mapping |
| `routes/pipeline_routes.py` | 381 | /run_pipeline, /run_esprit, /run_tracking, /run_feedin + adapter state |

`GET /gpu_status` returns `gpu_available` from a CuPy `import` probe — it is
`true` only when `cupy-cuda12x` is installed in `PianoidCore/.venv` (pinned in
`requirements.txt`; not a transitive dep, so venv rebuilds can drop it). Without
it, ESPRIT degrades to CPU and now logs a `WARNING` rather than failing silently
(dev-5dd4, 2026-05-22). See [MODAL_ADAPTER_GUIDE § Architecture](../../guides/MODAL_ADAPTER_GUIDE.md#architecture).

Backwards-compat shims (legacy underscore-prefixed names like
`_get_adapter`) remain on `routes/__init__.py` so the 16 existing
test imports keep working unchanged.

### `/modal/projects/copy` + `/create_from_zip` retired (N8)

Both endpoints now return `410 Gone` with the same JSON body shape as
the v1 collect retirement (Phase 2a):

```json
{
    "error": "endpoint_retired",
    "retired_at": "v2",
    "phase": "Phase 2c",
    "replacement": "/modal/projects/<old>/branch",
    "doc": "docs/proposals/modal-adapter-measurement-entity-2026-05-10.md#34-endpoints-removed--hard-cutover-at-phase-2-n8"
}
```

The frontend `useProjectCRUD.copyProject` helper is now a throwing stub
that surfaces the breakage at the call site (instead of silently
issuing a 410 round trip). `useProjectCRUD.importProject` retains
support for `.pianoid-project` archives (the export/import round trip
is unchanged) but throws on any other zip type.

The underlying `ModalAdapter.copy_project()` and
`ModalAdapter.create_project_from_zip()` Python methods remain in place
for direct callers (tests, scripts, REST replacements) until a
follow-on session retires them.

## Measurement Import endpoints (dev-maimport, 2026-05-19)

Three new endpoints back the Measurement Import dialog
(see [`MODAL_ADAPTER_GUIDE.md` § Measurement Import](../../guides/MODAL_ADAPTER_GUIDE.md#measurement-import-dev-maimport)).
They live on the same `modal_bp` blueprint as the rest of
`/modal/measurements/*` and reuse the v2 entity machinery — the
`MeasurementCatalog`, `Measurement.create()`, `setup/*` write paths,
and the slug-normalisation rules (N1). Shared implementation:
`pianoid_middleware/modal_adapter/measurement_import.py`.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/modal/measurements/probe` | Sniff a server-side path and report its layout / setup-config availability. No writes. |
| POST | `/modal/measurements/import_folder` | Create a new Measurement by copying or moving an existing folder. |
| POST | `/modal/measurements/unzip_helper` | Extract a raw measurement zip into `<measurements_base>/_staging/<name>_<TS>/`. The frontend then hands the returned `extracted_path` to `import_folder` — single unified flow. |

### `POST /modal/measurements/probe`

```bash
curl -X POST http://127.0.0.1:5001/modal/measurements/probe \
  -H "Content-Type: application/json" \
  -d '{"source_path": "D:/modal_measurements/PlyWoodTake1_7"}'
```

Response (always 200; the `format` field encodes "unknown" cases):

```json
{
  "format": "v2_measurement",
  "scenarios_parent": "D:\\modal_measurements\\PlyWoodTake1_7\\scenarios",
  "scenarios_detected": 30,
  "num_channels": 8,
  "sample_rate": 48000,
  "has_metadata": true
}
```

Format values:

- `roomresponse` — scenario sub-folders carry `raw_recordings/` or
  `averaged_responses/` directly under the picked path (or one
  wrapping directory below).
- `v2_measurement` — the picked path IS a Measurement directory
  (has `measurement.json` + `scenarios/` sub-dir). The detector
  auto-descends into `scenarios/` so the user can pick a Measurement
  root and the import path still works.
- `flat_npy` — flat directory of `scenario_*.npy` files. (Reserved;
  the current import flow only ships the scenario-folder layouts.)
- `unknown` — nothing recognisable. The `reason` field explains why.

`has_metadata: true` means the first scenario has
`metadata/session_metadata.json` available for `setup/*` auto-fill.
When `false`, the import will use module defaults regardless of the
`apply_source_config` flag.

### `POST /modal/measurements/import_folder`

```bash
curl -X POST http://127.0.0.1:5001/modal/measurements/import_folder \
  -H "Content-Type: application/json" \
  -d '{
    "source_path": "D:/modal_measurements/PlyWoodTake1_7",
    "measurement_id": "PlyWoodTake1_7_imported",
    "apply_source_config": true,
    "copy_or_move": "copy"
  }'
```

Body fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `source_path` | yes | — | Absolute path to the source folder (scenarios parent, wrapper dir, or v2 root). |
| `measurement_id` | yes | — | New Measurement name (normalised per N1; 409 on collision; 422 on bad slug). |
| `apply_source_config` | no | `true` | When `true` and the first scenario has metadata, populate `setup/*.json` from the captured `recorder_config`. When `false`, use module defaults. |
| `copy_or_move` | no | `"copy"` | `"copy"` (safe) or `"move"` (faster, mutates source). |

Response 201 body adds these extras to the standard `Measurement.summary()`:

```json
{
  "measurement_id": "PlyWoodTake1_7_imported",
  "measurement_path": "D:\\modal_measurements\\PlyWoodTake1_7_imported",
  "num_scenarios": 30,
  "num_channels": 8,
  "sample_rate": 48000,
  "acquisition_locked": false,
  "created": "2026-05-19T15:34:58Z",
  "scenarios_imported": 30,
  "source_config_applied": true,
  "detected_format": "v2_measurement",
  "source_path": "D:\\modal_measurements\\PlyWoodTake1_7",
  "scenarios_parent": "D:\\modal_measurements\\PlyWoodTake1_7\\scenarios"
}
```

**D3 — imports stay unlocked** (orchestrator decision, dev-maimport
2026-05-19). The N4 auto-lock that fires after the first internally-
captured scenario is **NOT** applied on import. This keeps the
Measurement extensible — the user can add more scenarios or edit
`setup/*` immediately after import. The user can still manually lock
from the Collection subpanel header once they're done. The CLI
migration path (`migrate_to_measurement_entity.py`) keeps its
existing auto-lock-on-apply behaviour (`reason: "migration_v1_to_v2"`)
unchanged.

Status codes:

- 201 — created.
- 400 — malformed body, unknown source format, or bad
  `copy_or_move` value.
- 409 — `measurement_id` already exists (N1). Body includes
  `code: "duplicate"`.
- 422 — invalid `measurement_id` slug.
- 500 — unexpected error.

### `POST /modal/measurements/unzip_helper`

```bash
curl -X POST http://127.0.0.1:5001/modal/measurements/unzip_helper \
  -F "file=@D:/path/to/measurements.zip" \
  -F "base_name=PlyWoodFresh"
```

Extracts the upload into `<measurements_base>/_staging/<base_name>_<YYYYMMDD-HHMMSS>/`
and runs the same layout-detection helper used by the Folder tab.
Returns 200 with:

```json
{
  "extracted_path": "D:\\modal_measurements\\_staging\\PlyWoodFresh_20260519-153012\\Inner",
  "staging_root": "D:\\modal_measurements\\_staging\\PlyWoodFresh_20260519-153012",
  "detected_format": "roomresponse",
  "scenarios_detected": 30
}
```

The frontend dialog then transparently POSTs `import_folder` with
`source_path = extracted_path` — same unified flow as picking an
existing folder.

Status codes:

- 200 — extraction succeeded.
- 400 — missing file / unzip failed / unknown layout after extraction.
- 500 — unexpected error.

### `session_metadata.json` → `setup/*` mapping

`measurement_import.session_metadata_to_setup_configs()` translates
the captured `recorder_config` blob into the four Measurement setup
files. Mirror image of `collection_engine._build_recorder_config_from_measurement`
(which goes the other way). Unit conversions applied:

| Source field (recorder_config) | Target setup field | Conversion |
|---|---|---|
| `sample_rate` (Hz) | `audio_config` manifest + `Measurement.sample_rate` | none |
| `input_device` / `output_device` (int) | `audio_config.input_device` / `.output_device` | none |
| `input_device_name` / `output_device_name` (str) | `audio_config.input_device_name` / `.output_device_name` | none |
| `multichannel_config.*` (object) | `audio_config.multichannel_config.*` | keys copied verbatim (`enabled`, `num_channels`, `channel_names`, `calibration_channel`, `reference_channel`, `response_channels`, `normalize_by_calibration`, `alignment_correlation_threshold`, `alignment_target_onset_position`) |
| `impulse_form` (str) | `impulse_config.impulse_form` | none |
| `pulse_duration` (seconds) | `impulse_config.pulse_duration_ms` | × 1000 |
| `pulse_frequency` (Hz) | `impulse_config.pulse_frequency_hz` | none |
| `pulse_fade` (seconds) | `impulse_config.pulse_fade_ms` | × 1000 |
| `pulse_smoothing_ms` (ms) | `impulse_config.pulse_smoothing_ms` | none |
| `invert_polarity` (bool) | `impulse_config.invert_polarity` | none |
| `volume` (0..1) | `impulse_config.volume` | none |
| `num_pulses` (int) | `series_config.num_pulses` | none |
| `cycle_duration` (seconds) | `series_config.cycle_duration_ms` | × 1000 |
| `series_config.record_extra_time_ms` (ms) | `series_config.record_extra_time_ms` | none |
| `series_config.averaging_start_cycle` (int) | `series_config.averaging_start_cycle` | none |
| `num_measurements` (int) | `series_config.num_measurements` | none |
| `measurement_interval` (seconds) | `series_config.measurement_interval_s` | none |
| (no source) | `mapping_config` | `default_mapping_config()` |
| (no source — `calibration_quality_config` is a runtime gate, not a Measurement-level rule list) | `calibration_criteria` | `default_calibration_criteria()` |

Missing fields fall through to the matching `default_*_config()`
value — every output is default-shaped, so consumers see a valid
schema even when the source metadata is sparse or absent.

## Filesystem List endpoints (dev-maimport, 2026-05-19)

Backs the server-side directory tree picker in the Measurement Import
dialog. Lives in `pianoid_middleware/modal_adapter/fs_routes.py`,
mounts under `/modal/fs/*`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/modal/fs/roots` | Returns suggested starting roots: named roots (measurements base, home, repo root) + every drive enumerated dynamically per request. |
| GET | `/modal/fs/list?path=<abs>` | Lists one directory (dirs first, then files). |

### Dynamic drive enumeration (portable / removable drives)

Drive roots in `GET /modal/fs/roots` are enumerated **dynamically on
every request** so a portable / removable drive plugged in AFTER the
modal-adapter server started shows up on the next call. The frontend's
Refresh icon in the tree picker re-fetches this endpoint (in addition
to re-fetching the current path listing) so users can plug in their
drive and click Refresh without restarting the backend.

**Windows.** Uses `ctypes.windll.kernel32.GetLogicalDrives()` (returns
a 32-bit bitmask where bit N is set if drive `chr(ord('A')+N):`
exists) plus `GetDriveTypeW(path)` per present drive to map the drive
type. No new Python dependency — `ctypes` is in the stdlib.

| Windows drive-type code | `kind` value | Notes |
|---|---|---|
| 0 (UNKNOWN) | `drive_unknown` | rare; surfaced as-is |
| 1 (NO_ROOT_DIR) | — | filtered out (stale enumeration entry) |
| 2 (REMOVABLE) | `drive_removable` | USB sticks, SD cards, portable HDDs (THIS is what the "I want to import from the portable drive" case maps to) |
| 3 (FIXED) | `drive_fixed` | internal HDD/SSD |
| 4 (REMOTE) | `drive_network` | mounted network shares |
| 5 (CDROM) | `drive_cdrom` | optical / virtual ISO |
| 6 (RAMDISK) | `drive_ramdisk` | rare |

**Linux.** No cheap drive-type API exists — best-effort scan of
`/proc/mounts` filtered for the conventional removable-mount parents
(`/media`, `/mnt`, `/run/media`). Root filesystem `/` is always
included first with `kind: "drive_fixed"`. Any matching mount point
is tagged `kind: "drive_removable"`. When `/proc/mounts` is
unavailable, falls back to listing direct children of the three
removable parents.

### Security: dynamic allowlist

Both endpoints refuse paths that are not under at least one
returned root — request for `C:\Windows\System32` (or any system
path outside the allowlist) returns HTTP 403 with
`code: "outside_allowed_roots"` and the `allowed_roots` array.

**The allowlist follows the dynamic enumeration** — any drive root
the enumeration surfaces (including a freshly-plugged portable
drive) is allowed, plus the named roots. This is the explicit
relaxation made in dev-maimport's follow-up (2026-05-19): the
previous hardcoded allowlist (`C:\`, `D:\` only) refused requests
under a portable drive at `E:\` because it wasn't on the static
list. The dynamic enumeration removes the hardcoding without
opening the door to arbitrary system paths — only paths that
descend from a discovered drive root are accepted.

### `GET /modal/fs/roots` response

```json
{
  "roots": [
    {"name": "D:\\modal_measurements", "path": "D:\\modal_measurements",
     "is_dir": true, "kind": "measurements_base"},
    {"name": "C:\\Users\\astri", "path": "C:\\Users\\astri",
     "is_dir": true, "kind": "home"},
    {"name": "D:\\repos\\PianoidInstall", "path": "D:\\repos\\PianoidInstall",
     "is_dir": true, "kind": "repo_root"},
    {"name": "C:\\", "path": "C:\\", "is_dir": true, "kind": "drive_fixed"},
    {"name": "D:\\", "path": "D:\\", "is_dir": true, "kind": "drive_fixed"},
    {"name": "E:\\", "path": "E:\\", "is_dir": true, "kind": "drive_removable"}
  ]
}
```

`kind` values: `measurements_base`, `home`, `repo_root`,
`drive_fixed`, `drive_removable`, `drive_network`, `drive_cdrom`,
`drive_ramdisk`, `drive_unknown`. The frontend uses `kind` to render
friendly chip labels and colour-codes removable (secondary) and
network (info) chips for at-a-glance distinction.

`GET /modal/fs/list?path=D:/modal_measurements` response:

```json
{
  "path": "D:\\modal_measurements",
  "parent": "D:\\",
  "entries": [
    {"name": "PlyWoodTake1_7", "path": "D:\\modal_measurements\\PlyWoodTake1_7",
     "is_dir": true},
    {"name": "readme.txt", "path": "D:\\modal_measurements\\readme.txt",
     "is_dir": false, "size": 142}
  ]
}
```

Entry ordering: directories first (case-insensitive sort by name),
then files (case-insensitive sort by name). `parent` is `null` only
when `path` is at the filesystem root.

Status codes:

- 200 — listing returned.
- 400 — missing or blank `path` query parameter.
- 403 — path outside the allowed-root allowlist (the response body's
  `allowed_roots` includes every dynamically discovered drive), or
  permission-denied while enumerating.
- 404 — path does not exist or is not a directory.

## Canonical v1+v2 project-scenarios resolution (dev-maimport round 5, 2026-05-19)

Backend methods that need to walk a Project's scenario data on disk
must NEVER reinvent the v1-only candidate list — use
`ModalAdapter._resolve_project_scenarios_path(meta)` instead.

**Why:** the modal_adapter is going through a v1 → v2 schema migration.
v1 projects persist `extracted_path` (set by the retired
`create_from_zip` flow) or `measurement_source` (set by the v1
`create_project(source=...)` flow). v2 projects persist
`measurement_path` + `measurement_id` (set by
`create_project_from_measurement` + Branch).
Methods that only check the v1 fields silently return empty data
for v2 projects — round 5 found 4 such sites in `modal_adapter.py`
alone (round 4 already fixed one in `open_project`).
**`_resolve_project_scenarios_path` is the one true place where this
resolution lives.** Consumers pass the project.json dict, get back
the absolute scenarios-parent path (or None for orphans).

**Canonical field-check order** (priority high → low):

| Order | Field | Path computed | Schema |
|-------|-------|---------------|--------|
| 1 | `meta["extracted_path"]` | (directly the scenarios-parent) | v1 — `create_from_zip` |
| 2 | `meta["measurement_source"]` | (directly the scenarios-parent) | v1 — `create_project(source=...)` |
| 3 | `meta["measurement_path"]` | `<measurement_path>/scenarios` | v2 — `create_project_from_measurement`, Branch |
| 4 | `meta["measurement_id"]` | `<$PIANOID_MEASUREMENTS_DIR>/<measurement_id>/scenarios` | v2 — cross-machine fallback when the absolute `measurement_path` is stale (e.g. project moved between machines with different base dirs) |

Each candidate is validated (`os.path.isdir` AND
`_dir_has_roomresponse_scenarios` — at least one sub-folder with
`averaged_responses/`) before commitment. Returns the first candidate
that resolves, or `None` if no candidate is reachable — caller treats
`None` as "scenarios unavailable, surface a friendly 'No data' /
'Re-import' prompt" rather than silently loading from a wrong root.

**Consumers as of round 5** (every site that touches project scenarios):

| Method | Use | Behaviour when resolver returns None |
|--------|-----|--------------------------------------|
| `_scenario_folders_for_project` | QC summary / scenario-name lookup | Returns `[]` → QC panel shows "No QC curves available" |
| `get_qc_curves` (fallback path) | Per-channel QC curve fetch | Raises `FileNotFoundError("Scenario X not found... have: [])` |
| `reaverage_project` | Re-run the averager on existing source | Raises `ValueError(no resolvable measurement source)` |
| `_load_v2_scenarios_from_parent_measurement` | v2 open-project fallback (round 4) | Logs warning, leaves `_measurements` empty (downstream pipeline 409 surfaces the user-friendly recovery prompt) |

**`ctx.source_folder` invariant (dev-frfres-9c41, 2026-05-25):** every
state-mutating loader (v1 `load_folder`, v1 `load_roomresponse_scenarios`,
**and** v2 `_load_v2_scenarios_from_parent_measurement`) must set
`ctx.source_folder` to the **parent of the scenarios directory** — i.e.
the directory that contains a `scenarios/` subfolder (v2 layout) OR the
directory that contains scenario subfolders directly (v1 RoomResponse
layout). This is the contract `FrfOrchestrator._resolve_scenario_dirs`
depends on (it appends `/scenarios` to `source_folder` first and only
falls back to `source_folder` directly if that path is absent). Skipping
the assignment in v2 caused `POST /modal/run_frf` to raise
`"No usable measurement source folder for FRF; resolved=None"` on every
v2 project whose `measurements/` directory was empty — the canonical v2
layout — even though the parent Measurement's `raw_recordings/` were
fully present.

`delete_project` is a special case (not a consumer): it explicitly
reads `meta["measurement_source"]` to decide whether to rmtree the
extracted Measurement folder. For v2 projects, that field is null
by design (the parent Measurement is shared across siblings —
N6 invariant) so deletion routes the user through
`DELETE /modal/measurements/<id>` instead of cascading from the
Project delete.

**Adding a new method that needs the scenarios path?** Call the
helper. Do not reinvent the candidate list. The next time someone
adds a v3 schema field, only the helper needs to change.

## Validation is recording-stage only (dev-maimport round 7, 2026-05-19)

**Architectural principle (locked by user direction, 2026-05-19):**

> Validation should be applied at the recording stage ONLY. Should
> not be reapplied to the imported measurements. Only averaging
> quality check.

In code this means a sharp split between two pipelines:

| Pipeline | Module / function | Validation? | What runs |
|---|---|---|---|
| **Recording stage** | `scenario_averager.ensure_averaged_responses` (and the recorder itself in `measurement/recorder.py`) | YES — `CalibrationValidatorV2.validate_cycle()` runs per cycle; failures are excluded from the averaged outputs that get written to `averaged_responses/average_ch{N}.npy` | calibration validation → align by onset → normalise by calibration → average → truncate → write `average_ch*.npy` + `effective_signal_length.json` |
| **Analysis stage** | `scenario_averager.pool_scenario_cycles` (consumed by `get_qc_curves` / the Setup-subpanel's `<QCVisualizationPanel>`) | **NO** — cycles are accepted as-is regardless of recording-stage validation outcome | extract cycles → (skip validation; synthesise all-valid result list) → align by onset → normalise by calibration → pool → per-channel split-half QC (the "averaging quality check") |

**Why this matters.** When a Measurement is imported (or re-opened on
a different machine, or its source dataset uses a
`calibration_quality_config` schema the in-tree validator doesn't
recognise), re-running per-cycle validation at analysis time would
incorrectly reject valid cycles. The cycles have already passed
whatever validation the original recorder enforced — that decision is
baked into the recording artefact. The analysis stage only needs to
re-pool the cycles (same canonical align + normalise as the recorder)
and run the new "averaging quality check" (split-half reproducibility)
that wasn't available at recording time.

**Where the principle is enforced.** `pool_scenario_cycles` (in
`scenario_averager.py`) synthesises a fake `validation_results` list
where every cycle is marked `calibration_valid: True`. This is the
minimal-surface-area implementation that preserves the
`SignalProcessor` contract (which is shared with the recording path)
while opting the QC compute path out of the validator. **Do not add
calls to `CalibrationValidatorV2` in the analysis path** — if you
need to add one, you're working on the recording stage and should
extend `ensure_averaged_responses` instead.

**Failure modes the principle resolves:**

- v1: source `calibration_quality_config` uses a schema the
  in-tree `CalibrationValidatorV2` doesn't recognise → every cycle
  failed validation → 0 cycles survived → 404 "only 1 cycles
  survived (need ≥ 4 for split-half)". Round 7 unblocks this.
- v2: project re-opened on a different machine where the validator
  thresholds drift between versions → cycles that passed at
  recording time fail at re-open time → QC display empty. Round 7
  unblocks this.
- v3: imported Measurement where the recording-time validator
  wasn't even available — only the averaged outputs exist. Round 7
  treats this case identically to the canonical case.

**Tests covering the principle** (in
`tests/integration/test_measurement_import.py::TestRound7ValidationSkipAtAnalysisStage`):

- `test_pool_synthesises_all_valid_validation_results` — pool
  produces non-zero cycles per response channel on clean data
- `test_pool_does_not_invoke_validator` — source-inspection guard
  that catches a future accidental re-add of `validator.validate_cycle`
- `test_recording_stage_averager_still_uses_validator` — guard
  against over-eager refactoring that strips validation from the
  recording side too
- `test_pool_succeeds_when_calibration_quality_config_has_unknown_schema` — direct repro of the user's blocked PlyWood
  dataset; cycles flow through the pool regardless of the source's
  unsupported `calibration_quality_config` keys

## Round 8 — mapping_config import + ESPRIT defensive errors (dev-maimport, 2026-05-19)

Three related backend changes that close a class of "silent 0-mode"
failures in the analysis pipeline.

### 1. mapping_config port from source session_metadata

`import_folder_as_measurement` (round 1) reads each source scenario's
`metadata/session_metadata.json` and ports the `recorder_config` blob
into the four Measurement `setup/*` config files. **Round 8 extends
this to populate `setup/mapping_config.json::channel_roles`** from
`recorder_config.multichannel_config.calibration_channel` +
`recorder_config.multichannel_config.response_channels`. Pre-round-8
the mapping always defaulted to empty `channel_roles: {}` regardless
of source — every imported Measurement opened with no response
channels assigned, and ESPRIT silently produced 0 modes.

Field-by-field mapping:

| Source field (in `multichannel_config`) | Mapping role |
|---|---|
| `calibration_channel` (int) | `channel_roles[<idx>] = "reference"` |
| `response_channels` (list of int) | `channel_roles[<each idx>] = "response"` |
| (channels not in either field) | absent from `channel_roles` — effectively unassigned |

Why `reference` for the calibration channel? `modal_adapter/mapping.py`'s
canonical role enum is `force / reference / response` — there is no
`calibration` role. `reference` is semantically correct: the
calibration channel provides the reference signal used to normalize
the response channels, exactly what `reference_channels` is for in
the mapping module.

**Migration note for measurements created BEFORE round 8** (incl. via
the legacy "+ New Measurement" empty-create UI followed by manual
scenario population): their `setup/mapping_config.json` was generated
with empty `channel_roles` and is NOT auto-upgraded by round 8 — only
fresh imports via `import_folder_as_measurement` get the mapping
port. **Path forward: re-import the source folder as a new
Measurement** (e.g. `PlyWood` → `PlyWood_r8`). A "re-derive mapping
from session_metadata" UI helper for legacy Measurements is a deferred
follow-up; if you've accumulated state attached to the legacy
Measurement (Projects, ESPRIT runs) the simpler short-term fix is to
hand-edit `setup/mapping_config.json` to match the source's
multichannel_config.

### 2. `_run_esprit_sync` defensive error on empty response_channels

Pre-round-8, ESPRIT silently "succeeded" (`state=done, message=Complete`)
with 0 modes per scenario when the mapping had no `response`-roled
channels — the runner happily processed an empty channel list. User
saw "ESPRIT runs too fast" with no diagnostic, leading to ~3 rounds
of mis-diagnosis. Round 8 fails fast:

```python
if not response_channels:
    raise RuntimeError(
        "No response channels configured in mapping. Edit the "
        "project's mapping_config.json (or the Setup subpanel's "
        "channel-roles editor) to mark at least one channel as "
        "'response'. Current channel_roles: {...}"
    )
```

The `POST /modal/run_esprit` route then returns `state: error` with
this message in the body, which the frontend surfaces inline. Same
fail-fast applies when `_mapping` is None at all (different error
message: "Mapping not set" / "Mapping not configured").

### 3. Scenario-loading-gap surface

When `_load_v2_scenarios_from_parent_measurement` (round-4 fallback)
walks the parent Measurement's `scenarios/` directory, scenarios that
lack `averaged_responses/` are silently filtered out by
`_discover_roomresponse_scenarios`. Pre-round-8 the user saw
"`num_scenarios: 2`" when the disk had 3 scenarios, with no
explanation. Round 8 captures the gap on `self._scenario_loading_gap`
and surfaces it in `/modal/project_state.measurement_info`:

```json
{
  "measurement_info": {
    "num_scenarios": 2,
    "num_channels": 8,
    "sample_rate": 48000,
    "scenario_loading_gap": {
      "total_on_disk": 3,
      "loaded": 2,
      "excluded": [
        {"scenario_name": "PlyWood-Scenario6-LG",
         "reason": "no averaged_responses"}
      ]
    }
  }
}
```

The frontend's Project info panel renders an inline warning Alert
listing the excluded scenarios with their reasons. State is reset by
`reset()` so opening a different project doesn't leak the previous
gap.

**Tests** (in `tests/integration/test_measurement_import.py`):

- `TestRound8MappingConfigImport` (5 tests): calibration→reference,
  response→response, missing→default, partial-coverage, end-to-end
  on-disk round-trip mirroring user's PlyWood shape
- `TestRound8EspritEmptyChannelsError` (2 tests): empty-mapping +
  force-only-mapping both raise clear errors
- `TestRound8ScenarioLoadingGap` (2 tests): gap captured + surfaced;
  cleared on project switch

## Round 10 — PATCH /modal/measurements/<id>/<section> response shape (dev-maimport, 2026-05-20)

Backend route + frontend hook were both contributing to a silent-
data-corruption bug that affected **all 5 setup sections**
(audio_config, impulse_config, series_config, mapping_config,
calibration_criteria). User-visible symptom: "I cannot modify
grid and channel role parameters, settings are open but don't
persist on save".

**Root cause:** pre-round-10, `_patch_setup` returned only
`{"ok": True, "updated": <section>}` — an acknowledgement shape
with no section payload. The frontend hook's response-mirror logic
`useMeasurementSetup.js:116` had a fallback chain
`res?.data?.[section] || res?.data || body` whose middle clause
`|| res?.data` captured the ack object (truthy) and stored it as
the section's canonical shape in `manifest.setup[section]`. Next
render showed garbage. Next save merged the user's edit into the
`{ok, updated}` shell and PATCHed back to disk → eventual on-disk
corruption like `{"ok": true, "updated": "mapping", "channel_roles": {...}}`
(missing layout_type, bridge_boundary, etc.).

**Fix (both sites, defense in depth):**

Backend (`measurement_routes.py::_patch_setup`): after a successful
`write_setup_config`, re-reads the file from disk via
`read_setup_config` and includes the full canonical body in the
response under the section-name key:

```json
{
  "ok": true,
  "updated": "mapping",
  "mapping_config": { ...full canonical 7-key body... }
}
```

The section-name key uses the long form (`audio_config` /
`impulse_config` / `series_config` / `mapping_config` /
`calibration_criteria`) — same form the URL path uses + the
frontend's `manifest.setup[section]` keys against.

Frontend (`useMeasurementSetup.js`): fallback chain reduced from
3 alternatives to 2 — `res?.data?.[section] || body`. The middle
`|| res?.data` clause that captured the ack shape is GONE.
Response-section-payload wins (round-10 backend always provides
it); falls back to the canonical request body if any future
endpoint doesn't follow the new contract. The ack wrapper can
NEVER be captured.

**Why both sites?** The backend fix eliminates the ambiguity that
invited the bug — any client following the new contract is safe.
The frontend fix protects against any future endpoint that
returns acknowledgement-only responses without a section payload
(defensive). Both ~3-5 LOC, no overlap.

**Tests** (round-trip GET-after-PATCH coverage for all 5 sections):

Backend (`tests/integration/test_measurement_routes.py::TestRound10PatchResponseCarriesSavedBody`, +3 tests):
- `test_patch_response_contains_full_saved_body` — each of 5
  sections: PATCH a body, response carries `<section_key>` with
  the FULL post-merge content
- `test_patch_then_get_returns_same_shape` — PATCH then GET, on-
  disk has canonical shape (no `ok`/`updated` leaked into section)
- `test_repeated_patch_preserves_canonical_shape` — 3x progressive
  PATCH, final state == 3rd body verbatim (directly reproduces
  the user's failure mode)

Frontend (`src/hooks/__tests__/useMeasurementSetup.test.jsx`, +3 tests):
- "mirrors the section payload from response into manifest.setup"
- "CRITICAL: pre-round-10 corruption pattern — ack-only response
  must NOT pollute manifest" (directly reproduces the bug — if
  backend hypothetically returns ack-only, the hook MUST fall
  back to body, never capture the ack)
- "repeated PATCH preserves canonical shape" (frontend regression
  guard)

**Damage repair on user's data:** scanned all 26 Measurements in
`D:\modal_measurements` for the corruption signature (presence
of `ok` or `updated` keys at top level of any setup file). After
round 10: 0 corrupted files remain. User's `PlyWoodSmallGrid`
mapping_config was already repaired by the round-10 diagnostic-
phase PATCH (canonical 7-key body) before code fix landed.

## Cross-Links

- [DATA_FLOWS.md § Measurement Collection Flow](../../architecture/DATA_FLOWS.md#measurement-collection-flow)
- [pianoid-middleware OVERVIEW: Measurement Stack (Phase 0 RR-port)](OVERVIEW.md#measurement-stack-phase-0-rr-port-dev-rrport-2026-05-10)
- [REST_API.md: Measurement Collection Endpoints](REST_API.md#measurement-collection-endpoints-port-5001--v2-measurement-entity)
- [Proposal §3.4 N8 hard cutover](../../proposals/modal-adapter-measurement-entity-2026-05-10.md#34-endpoints-removed--hard-cutover-at-phase-2-n8)
- [MODAL_ADAPTER_GUIDE.md § Project Management (Phase 2c rework)](../../guides/MODAL_ADAPTER_GUIDE.md#project-management)
