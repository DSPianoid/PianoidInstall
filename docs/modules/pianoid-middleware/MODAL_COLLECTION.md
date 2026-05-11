# Modal Adapter Measurement Collection

**Status (Wave B-1):** REST surface for measurement collection is in place.
The Modal Adapter server (port 5001) can run a complete measurement
scenario via REST, end-to-end, with no manual steps. A curl-only operator
can: configure a scenario → start collection → monitor status → fetch the
resulting averaged IR. The frontend Collect panel is deferred to Wave B-3.

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

All five endpoints are mounted under `/modal/collect/*` on the
**modal_adapter_server only (port 5001)**. The main backend (port 5000)
exposes only the health probe; collection routes return HTTP 503 there
because the in-tree measurement stack is not probed (and the audio
device cannot be opened twice in the same process anyway).

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/modal/collect/health`           | In-tree measurement-stack probe (sdl_audio_core + measurement.recorder importable). Pre-Phase-0 this was the RR sys.path bootstrap probe. |
| POST   | `/modal/collect/start`            | Begin one scenario |
| GET    | `/modal/collect/status`           | Active session snapshot |
| POST   | `/modal/collect/cancel`           | Cancel active session |
| GET    | `/modal/collect/results/<sid>`    | Fetch completed-session result |
| GET    | `/modal/collect/devices`          | Enumerate SDL3 audio devices |

See [REST_API.md](REST_API.md#modal-collection-endpoints-port-5001-b-1) for
request/response schemas.

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

## Curl-Only End-to-End Example

```bash
# 1. Confirm the modal adapter server has the in-tree measurement stack ready
curl http://127.0.0.1:5001/modal/collect/health
# {"available":true,"sdl_version":"3.2.0","error":null,"room_response_path":null}
# (room_response_path is now always null after the Phase 0 in-tree port)

# 2. List audio devices
curl http://127.0.0.1:5001/modal/collect/devices

# 3. Start a scenario
curl -X POST http://127.0.0.1:5001/modal/collect/start \
  -H "Content-Type: application/json" \
  -d '{"scenario_number":0,"project_dir":"D:/data/myproject",
       "recorder_config":{"num_measurements":5,
         "computer":"Belarus","room":"Run1"}}'
# {"session_id":"d0722c397e99"}

# 4. Poll progress
curl http://127.0.0.1:5001/modal/collect/status

# 5. Fetch results
curl http://127.0.0.1:5001/modal/collect/results/d0722c397e99
```

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
| POST   | `/modal/measurements/<id>/setup_test`                      | Run Setup Test (Phase 1 stub — Phase 2 wires `signal_processor.validate_calibration_quality`). Overwrites `setup_test/latest.*` per N3 |
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

### Setup Test (Phase 1 stub)

Per spec §6, the actual `signal_processor.validate_calibration_quality`
wiring lands in **Phase 2** alongside the UI that consumes it. Phase 1
ships the **endpoint surface** (request/response shapes, N3
single-latest retention, criteria iteration) returning
`overall: "not_implemented"` and `verdict: "not_implemented"` per
criterion. The audio-device probe is wired but does not actually emit
a calibration impulse.

### Locks and N4

- Auto-lock after first successful scenario (`record_scenario` writes `locks/acquisition.lock` if `num_scenarios` transitions 0->1)
- Migrated Measurements are sealed at apply time (`reason: "migration_v1_to_v2"` in the lock body) — re-collection requires explicit unlock
- `setup/*` writes are rejected with `MeasurementLockedError` -> 423 Locked
- `setup/calibration_criteria.json` is exempt (analysis-time gate)
- `POST /unlock {confirm: true}` is always available; lock auto-fires again on the next successful scenario

### Cross-Links

- Proposal: [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](../../proposals/modal-adapter-measurement-entity-2026-05-10.md) — authoritative spec, all 16 decisions baked in
- Tests: 133 cases across `tests/unit/test_measurement_entity.py` (56), `tests/unit/test_measurement_catalog.py` (22), `tests/integration/test_measurement_routes.py` (25), `tests/integration/test_project_v2_branch.py` (13), `tests/integration/test_migration_to_measurement.py` (17)

## Cross-Links

- [DATA_FLOWS.md § Measurement Collection Flow](../../architecture/DATA_FLOWS.md#measurement-collection-flow)
- [pianoid-middleware OVERVIEW: Measurement Stack (Phase 0 RR-port)](OVERVIEW.md#measurement-stack-phase-0-rr-port-dev-rrport-2026-05-10)
- [REST_API.md: Modal Collection Endpoints](REST_API.md#modal-collection-endpoints-port-5001-b-1)
