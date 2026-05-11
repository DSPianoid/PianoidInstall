# Modal Adapter Measurement Collection

**Status (Phase 2c, dev-msmtui-fc, 2026-05-11):** The per-Measurement
collect endpoints have shipped. Combined with Phase 2a's v1 retirement
+ Phase 2b's frontend Collection UX, the Measurement-entity refactor's
backend acquisition surface is complete; only Phase 3 (light SDL3.dll
share) and Phase 4 (streaming-messages polish) remain.

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
| `PianoidCore/sdl_audio_core/` (built by `build_pianoid_cuda.bat`) | RR `sdl_audio_core/` |

The `_room_response_bootstrap.py` shim and the `PIANOID_ROOMRESPONSE_PATH`
env var have been deleted. `GET /modal/collect/health` now returns the
status of an in-tree import probe rather than a sibling-repo discovery
probe — the response shape is unchanged for frontend compatibility.

See [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md)
§ Phase 0 for the rationale.

## Architecture

```
+-----------------------+        REST       +--------------------------------+
| Modal Adapter         |   /modal/collect/*|  modal_adapter_server (5001)   |
| Frontend (B-3, TBD)   |  ---------------> |                                |
+-----------------------+                   |  routes.py + collection_routes |
                                            |          |                     |
                                            |          v                     |
                                            |  MeasurementSession            |
                                            |  (single active session)       |
                                            |          |                     |
                                            |  thread  |                     |
                                            |          v                     |
                                            |  measurement.RoomResponseRecorder      |
                                            |  + measurement.SingleScenarioCollector |
                                            |  + measurement.generate_averaged_...   |
                                            |  (vendored in-tree, Phase 0)           |
                                            +-----------+--------------------+
                                                        |
                                                        |  pause / resume
                                                        v
                                            +--------------------------------+
                                            | backendServer.py (port 5000)   |
                                            | /pause_synthesis (200 = OK)    |
                                            | /resume_synthesis              |
                                            +--------------------------------+
```

The collection engine sits in
`PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py` and
is wired into the existing `modal_bp` blueprint via
`collection_routes.register_collection_routes(modal_bp)`.

### Single-active-session constraint

Collection is exclusive — the audio device cannot be opened twice. The
`MeasurementSession` instance lives on `app.config['measurement_session']`
and tracks one in-flight scenario at a time:

| State | Meaning |
|-------|---------|
| `idle` | No active session |
| `pausing` | Posting `/pause_synthesis` to backend |
| `recording` | RoomResponseRecorder + SingleScenarioCollector running |
| `saving` | Generating averaged_responses + measurements/ mirror |
| `resuming` | Posting `/resume_synthesis` to backend |
| `done` | Success terminal |
| `cancelled` | Cancellation requested mid-flight |
| `error` | Pause failed, recording crashed, or save failed |

A `start()` call while another session is in flight returns HTTP 409.
Cancellation is signalled via `threading.Event`; the worker thread
checks between phases and on success/failure/cancel always attempts a
final `/resume_synthesis` so Pianoid is not left paused.

## Pause/Resume Coordination

Pianoid must release the OS audio device before RoomResponse can open it.
The B-0 audit confirmed `/pause_synthesis` ultimately invokes
`SDL3AudioDriver::stopPlayback`, which destroys the SDL3 audio stream
and releases the device.

```
collect/start  -->  pausing       --> POST /pause_synthesis @ 5000
                    | OK (200)        (200 also when no preset is loaded -- nothing to release)
                    | 5xx or unreachable: phase=error, NO resume attempted
                    v
                    recording     --> RoomResponseRecorder.take_record(...)
                    | scenario complete
                    v
                    saving        --> generate averaged_responses/ + scenario_N.npy mirror
                    |
                    v
                    resuming      --> POST /resume_synthesis @ 5000
                    | (always attempted on success / error / cancel paths if pause succeeded)
                    v
                    done | error | cancelled
```

If `/pause_synthesis` is unreachable or returns 5xx, the session aborts
without opening the audio device — Pianoid keeps exclusive ownership.
This is the correct fail-fast (P5) for shared-device contention.

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
| `input_device` / `input_device_name` | int / str | SDL3 input ordinal + name (name takes priority) |
| `output_device` / `output_device_name` | int / str | SDL3 output ordinal + name |
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
| DELETE | `/modal/measurements/<id>`                                 | Delete. 409 with `{linked_projects: [...]}` if any Project references this Measurement (N6, no force flag) |

**Project endpoints (Phase 1 additions):**

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/modal/projects`                                          | v2 Create — body `{name, measurement_id, band_config?}`. Snapshots parent's setup at create time per N5. URL-param `?measurement=<id>` is an alternative. 404 unknown measurement, 409 name collision |
| POST   | `/modal/projects/<old>/branch`                             | Branch sibling Project — body `{new_name, inherit_band_config?}`. Snapshots parent at branch time (can differ from source if parent was unlocked+edited). 409 if source is v1 (no measurement_id) |

**Existing project endpoints unchanged** during Phase 1: `/modal/projects/create`, `/modal/projects/open`, `/modal/projects/copy`, `/modal/projects/delete`, `/modal/projects/<n>/rename`, `/modal/projects/<n>/reaverage`, etc.

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

1. Pause Pianoid synthesis (`POST /pause_synthesis @ 5000`). On failure
   the route returns **502 Bad Gateway** with `code: "pause_failed"`;
   the audio device is never opened.
2. Stitch the Measurement's `setup/{audio,impulse,series,mapping}_config.json`
   into a single recorder cfg via `build_recorder_config()`.
3. Construct `RoomResponseRecorder` (in-tree port from Phase 0) and
   invoke `take_record(mode='calibration', save_files=False)` for one
   calibration cycle — NO scenario folder, NO averaging, NO N4 auto-lock.
4. Evaluate each `setup/calibration_criteria.json` entry against the
   measured signal. The default 5 criteria each dispatch to a
   per-criterion measurement function (`_measure_for_criterion`) and
   per-criterion comparison (`_criterion_passes` — `>=` for "_min"
   criteria, `<=` for "_max" criteria). Criteria whose target channels
   aren't configured surface as `verdict: "not_applicable"` and don't
   escalate the overall.
5. Reduce: `overall = fail` if any `fail_action="fail"` criterion failed;
   else `warn` if any `fail_action="warn"` failed; else `pass`.
6. Resume Pianoid synthesis (`POST /resume_synthesis @ 5000`).
7. Write the report to `setup_test/latest.json` and the calibration
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
| GET  | `/modal/measurements/<id>/devices` | Enumerate SDL3 devices, with the Measurement's currently-selected input/output echoed back |
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
`num_pulses`, `series_config.volume` → `volume`, etc. The
`multichannel_config` block is deep-copied to prevent caller-mutation
back-leak.

The `voice_coil_config` sub-block in `setup/impulse_config.json` is
forward-looking — the current in-tree recorder does not consume it
(voice_coil-mode parameters are hardcoded). The stitching helper reads
it but does not propagate; if/when the recorder gains
`voice_coil_config` support, extend the helper.

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

`GET /modal/measurements/<id>/devices` returns:

```json
{
    "input_devices": [{"index": 0, "name": "MOTU UltraLite-mk5 (1)"}, ...],
    "output_devices": [{"index": 1, "name": "MOTU UltraLite-mk5 (2)"}, ...],
    "sdl_version": "3.2.0",
    "current_input": 3,
    "current_input_name": "MOTU UltraLite-mk5 (1)",
    "current_output": 1,
    "current_output_name": "MOTU UltraLite-mk5 (2)"
}
```

`current_*` are read from the Measurement's `setup/audio_config.json`
so the frontend Audio Devices Select dropdowns can pre-select the right
entry. The unscoped alias `/modal/measurements/devices` returns the same
shape with `current_*` set to `null` (no Measurement context).

`SDL3` not importable → 503 with `code=stack_unavailable`.

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

## Cross-Links

- [DATA_FLOWS.md § Measurement Collection Flow](../../architecture/DATA_FLOWS.md#measurement-collection-flow)
- [pianoid-middleware OVERVIEW: Measurement Stack (Phase 0 RR-port)](OVERVIEW.md#measurement-stack-phase-0-rr-port-dev-rrport-2026-05-10)
- [REST_API.md: Modal Collection Endpoints](REST_API.md#modal-collection-endpoints-port-5001-b-1)
- [Proposal §3.4 N8 hard cutover](../../proposals/modal-adapter-measurement-entity-2026-05-10.md#34-endpoints-removed--hard-cutover-at-phase-2-n8)
- [MODAL_ADAPTER_GUIDE.md § Project Management (Phase 2c rework)](../../guides/MODAL_ADAPTER_GUIDE.md#project-management)
