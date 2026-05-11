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

## Cross-Links

- [DATA_FLOWS.md § Measurement Collection Flow](../../architecture/DATA_FLOWS.md#measurement-collection-flow)
- [pianoid-middleware OVERVIEW: Measurement Stack (Phase 0 RR-port)](OVERVIEW.md#measurement-stack-phase-0-rr-port-dev-rrport-2026-05-10)
- [REST_API.md: Modal Collection Endpoints](REST_API.md#modal-collection-endpoints-port-5001-b-1)
