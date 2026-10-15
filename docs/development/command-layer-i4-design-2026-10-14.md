# I4 command layer: design note (dev-6026)

**Date:** 2026-10-14 · **Agent:** dev-6026 · **Implements:** [assistant-infrastructure proposal §7](../proposals/assistant-infrastructure-2026-10-13.md#7-i4-unified-command--action-layer--the-future-tool-registry)
**Builds on:** I1 journal + `write_routes` classification, I3 undo/redo (both merged).

This note fixes the design choices the proposal leaves open. It is the working doc for the session. The
lasting contract goes into `REST_API.md` ("Commands and jobs") and the Tunner `OVERVIEW.md` (command bus).

---

## 1. Registry

| Item | Decision |
|---|---|
| Location | PianoidInstall `schemas/commands/<family>.json`, one file per family (`playback`, `preset`, `render`, `param`, `history`, `calibration`, `modal`, `midi`, `job`, `launcher`). One file holds several commands, so a family is reviewed as a unit. |
| Resolution | Core and the launcher read `$PIANOID_COMMANDS_DIR`, else `<PianoidInstall>/schemas/commands` (resolved from their own location: `PianoidCore/..`, `PianoidTunner/..`). A worktree run sets the env var. A missing dir is a startup **error** in Core (fail fast), not an empty registry. |
| Format | `{"family": "...", "commands": [ {name, target, title, description, tier, long_running, doc, route, args, result} ]}`. `args` / `result` are JSON Schema **draft-07** objects. |
| `tier` | The six tiers of the parent doc §4.1: `read` · `ui` · `act` · `write` · `destructive` · `excluded`. The tier is assistant-envelope metadata only. UI / REST callers may run every tier. `excluded` commands are never exported as tools. |
| `route` (backend target) | `{method, path, query?}`. `path` may hold `{arg}` placeholders that are filled from `args` and removed from the body. The remaining args are the JSON body (POST) or the query string (GET). So every backend command is a **thin wrapper** of an existing route; no logic moves. |
| `route` (modal target) | The same shape, relative to `:5001`. Core forwards it over HTTP. |
| `route` (launcher target) | `{method, path}` on `:3001`; the launcher serves its own family (`GET /api/commands`, `POST /api/command/<name>`). |
| `long_running` | `true` → the executor returns `{jobId}` and the job emits lifecycle events (§3). |
| `doc` | MkDocs path + anchor, for example `modules/pianoid-middleware/REST_API.md#post-play`. A test checks that the anchor exists. |

### Validator (shared FE / BE)

The schemas use a **declared subset** of draft-07: `type`, `properties`, `required`,
`additionalProperties`, `enum`, `const`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`,
`oneOf`, `default`, `description`, `title`, `examples`. A pytest lint fails on any other keyword.
- **Backend:** `jsonschema` (draft-07, already in the venv). It is authoritative.
- **Frontend:** `utils/commandSchema.js`, a ~100-line validator for exactly that subset (no new npm
  dependency). It runs as a pre-flight check so a malformed UI call fails before it hits the wire.
- **Conformance:** `schemas/commands/_conformance.json` lists `(schema, value, valid)` cases. Both
  pytest (`jsonschema`) and Jest (`commandSchema.js`) run them, so the two validators cannot drift.

## 2. Executor (Core `command_registry.py`)

```
POST /command/<name>  {args}            headers X-Pianoid-Source/-Client/-Op/-Group (as today)
WS   command {name, args, source?, clientId?, opId?, groupId?}  -> ack {ok, status, result | error, jobId?}
GET  /commands                           -> {commands: [...registry...], families, version}
GET  /commands?format=tools              -> Anthropic tool definitions (name, description, input_schema), tiers != excluded
```

- **Mechanism: in-process re-dispatch of the existing route.** The executor validates `args`, builds the
  route URL, and runs `app.full_dispatch_request()` inside a fresh `app.app_context()` +
  `app.test_request_context(path, method, json=body, headers=source headers)`. So the existing
  `before_request` / `after_request` / `teardown_request` journal hooks, the `write_routes` classification,
  the read-only guard and the error handlers all run **exactly as for a direct call**. The only
  difference is the source headers. This is what makes the I4 acceptance test (UI button ≡ REST ≡ WS
  produce the same journal entries except `source`) hold by construction.
  - A fresh app context is required: a nested request context would otherwise share `g` with the outer
    `/command` request and clobber its journal context stack.
  - The nested journal context inherits the outer one's undo root, so one command = one undo group.
- **Result:** the route's JSON body, unchanged, plus the HTTP status: `{ok, status, result}`. A non-2xx
  status is passed through (REST returns the same status code; WS acks `{ok: false, status, error}`).
- **Validation error:** 400 `{error: 'invalid_args', details: [...]}` before any dispatch. Unknown name: 404.
- **Target `modal`:** `requests` to `http://127.0.0.1:5001<path>` with the same body; 503 `modal_unavailable`
  when `:5001` is down. Long-running modal commands get a job (§3).
- **Target `launcher` / `ui`:** not executable on `:5000` (409 `wrong_target`); the FE bus routes them.
- **`/command_names`** stays as a deprecated alias (dual paths are allowed during migration); the docs
  point to `/commands`.
- **Classification:** `command_route` and the WS `command` event are classified `action` in
  `write_routes.py`. The inner dispatch carries the real class, so nothing is double-counted.

## 3. Jobs (Core `job_manager.py`)

| Item | Decision |
|---|---|
| Model | `Job {id, name, family, state, pct, stage, msg, result, error, started_at, finished_at, source}`; states `pending → running → finished \| failed \| cancelled`. In-memory ring of the last 50 jobs. |
| Events (WS, to all clients) | `job_started {job}` · `job_progress {jobId, pct, stage, msg}` (coalesced to ≤ 10 Hz per job) · `job_finished {jobId, result}` · `job_failed {jobId, error}` · `job_cancelled {jobId}`. Unsequenced, like `history_changed` (not journal state). |
| Creation | **Generic, route-driven:** `before_request` looks up the endpoint in the registry's route → command map. If the command is `long_running`, a pending job is created and bound to `g`. `after_request` accepts it on 2xx (`job_started`, `jobId` added to the JSON response) or drops it on an error status. So a job exists whether the route is called through `/command`, directly by an old FE panel, or by curl. |
| Family adapters | One active job per family (calibration and modal already refuse a second run with 409). <br>• **calibration:** `emit_calibration_progress` also feeds `job_progress`; the calibration worker threads report their return value / exception to the active job. <br>• **modal:** a poller thread reads `:5001 /modal/status` every 0.5 s until `run_state` leaves `running`; `done` → finished (result = status), `error` → failed. <br>• **midi_playback:** a poller reads `get_online_midi_playback_status()` every 0.5 s until `complete`, or a `stop`. |
| Cancel | `job.cancel {jobId}` → the family adapter: calibration → `/calibration_cancel`; modal → `:5001 POST /modal/cancel`; midi → `/midi_playback {action: stop}`. Itself re-dispatched, so it is journalled like a direct cancel. |
| Read | `job.list` / `job.get {jobId}` (tier `read`). |

The old ad-hoc channels (`calibration`, `midi_progress`, `/calibration_status`) stay; the job events are
added alongside them, so no existing FE panel breaks.

## 4. Frontend command bus (Tunner `utils/commandBus.js`)

- `commandBus.dispatch(name, args, opts) → Promise<{ok, status, result, jobId?}>`.
- The registry comes from `GET :5000/commands` (fallback: `GET :3001/api/commands` for the launcher family
  when the backend is down). It is loaded once per backend boot (`/health.boot` change → reload).
- Pre-flight validation with `commandSchema.js`; `target`:
  - `backend` / `modal` → WS `command` (acked) when the socket is up, else `POST /command/<name>`.
    Both carry the `clientIdentity` source (`fe`, clientId, opId).
  - `launcher` → `POST :3001/api/command/<name>`.
  - `ui` → a locally registered handler (`commandBus.registerUi(name, fn)`; I5 fills it).
- **Migration (I4.2), first families:** playback (`play.note` incl. the virtual keyboard / space bar,
  `play.keyboard` sweep, `play.reset`), preset (`preset.load`, `preset.save`, `preset.switch`,
  `preset.spawn_working_copy`, `preset.promote`, `preset.unload`, `preset.load_to_library`), render
  (`render.chart` for the chart windows incl. `note_playback`). The old direct calls are replaced at
  the call site; the response handling stays as it is.
- `play.note` latency: the WS `command` path adds one in-process re-dispatch. **Measured** (ack round trip,
  200 note-offs, 3 runs): added p50 0.53–0.59 ms, p95 0.64–0.79 ms — under the 2 ms gate, so `play.note`
  (virtual keyboard, space bar, MIDI-via-FE) goes through the bus (fire-and-forget WS `command`).

## 5. Data Model Card (per-command args)

Units and key spaces come from the I0 card (`REST_API.md` "Parameter key spaces") and the endpoint docs;
the schemas repeat them in `description` so the generated tools carry them.

| Command | Arg | Unit / key space | Source |
|---|---|---|---|
| `play.note` | `pitch` | MIDI note number = preset pitch id (keys 21–108; output pitches ≥ 128 never sound) | REST_API `/play`, `#data-model-facts` |
| | `velocity` | MIDI 0–127; `command` 144 note-on / 128 note-off / 176–178 sustain (pitch 64) | REST_API `/play` |
| | `delay_ms` | ms, ≥ 0 | REST_API `/play` |
| `play.keyboard` | `speed_ms_per_note` 10–2000 ms, `velocity` 1–127, `tail_ms` 0–10000 | REST_API `/play_keyboard` |
| `param.set` | `parameter`, `key_no`, `values` | `parse_range` key space: feedin / feedback / masks / sound_channel keyed by **pitch**; mode params by mode; `key_no` accepts `n`, `a-b`, `all` | REST_API Data Model Card (I0) |
| `runtime.set` | `volume` 0–127 MIDI; `feedback` 1–127 mapped, else a direct coefficient | REST_API `/set_runtime_parameters` |
| `render.chart` | `chartType` + chart params; `note_playback`: `pitch`, `velocity`, `duration_ms`, `display_length_ms` | CHART_SYSTEM.md |
| `calibration.*` | `velocity` MIDI 1–127 (0 refused), `pitches` list or `"all"` (key pitches only) | REST_API calibration |
| `modal.run_stage` | `stage` ∈ {`pipeline`, `esprit`, `tracking`, `feedin`}; body passed through | REST_API modal |

[DMC] Stored vs effective: the commands never compute values; they pass args to the existing routes, so
the stored-vs-effective rules of each route apply unchanged.

## 6. Scope of this session

I4.0 (registry + schemas + validators + conformance) · I4.1 (executor, `/commands`, WS `command`,
jobs + calibration / modal / MIDI adapters, `job.cancel`) · I4.2 (FE bus + playback / preset / render
migration + launcher family). **I4.3** (moving the calibration / modal / rig *panels* to the bus) is
registry-ready (the calibration / modal commands exist and have jobs) but the panel migration is left
for a follow-up, unless the lead wants it in this session. `rig.session` (`/audio/session`) is
registered as `destructive`, not migrated. The launcher family is served (`/api/commands`,
`/api/command/<name>`) but `useBackendProcess` keeps its direct calls (its start button must work before any
registry is reachable).

**Found and fixed on the way (calibration_controller.py, pre-existing):** `/calibration_cancel` never stopped a
synthesis / acoustic pass (the tuners poll a copy of the running flag), and a pass refused by the engine left
`running = True` (every later pass 409). Both surfaced through the job model (a cancelled job kept progressing;
a failed job wedged the family).

## 7. Verification

| What | Surface | Pass |
|---|---|---|
| Registry lint + conformance | pytest + Jest | every schema uses the subset; every doc anchor exists; every backend route resolves to a classified endpoint; both validators agree on all cases |
| Executor contract | pytest integration (Flask test client + socketio test client, real engine) | `param.set`, `preset.switch`, `history.undo`, `play.note`: direct route vs `/command` vs WS `command` → identical journal entries except `source` |
| Jobs | pytest (fake adapters) + live | calibration (`calibration.synthesis` on a few pitches) and a modal stage: `job_started` → ≥ 1 `job_progress` → `job_finished`; cancel → `job_cancelled` |
| FE bus | Jest | target routing, pre-flight validation, WS → REST fallback, job event store |
| Live, two tabs | chrome-devtools on the worktree CRA (:3005) + worktree backend | toolbar save / switch / play / render through the bus → backend GET + journal shows `source: fe`; tab B sees the state events; a calibration job's progress is visible in both tabs |
| Latency | node socket.io client, 200 notes | `play` vs `command play.note` added p95 |
