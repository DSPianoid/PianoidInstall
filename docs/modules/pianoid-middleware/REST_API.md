# pianoid_middleware — REST API Reference

## Server Architecture

The middleware runs as **two Flask servers**:

| Server | Port | Role |
|--------|------|------|
| `backendServer.py` | 5000 | Synthesis engine, playback, parameters, calibration, presets |
| `modal_adapter_server.py` | 5001 | Modal extraction pipeline, project management, folder dialogs |

Both servers have CORS enabled for all origins. The frontend connects to both servers concurrently.

**Error-response CORS guarantee** — `backendServer.py` registers a global `@app.errorhandler(Exception)` that converts any uncaught exception into a JSON 500 response (`{"error": <ExceptionClass>, "message": <str>, "path": <request.path>}`). This ensures Flask-CORS attaches `Access-Control-Allow-Origin` to every error the browser might see. Werkzeug `HTTPException` responses (404, 400, etc.) are passed through unchanged — Flask-CORS handles those via `after_request`. Without this, the Werkzeug debug HTML 500 response is untagged and the browser blocks it as a CORS error, making the actual failure invisible to the frontend.

### WebSocket Channel (port 5000)

`backendServer.py` also provides a **Socket.IO WebSocket channel** on the same port (5000) for low-latency bidirectional communication. The WebSocket layer is purely additive — all REST endpoints remain functional.

| Feature | Transport | Direction |
|---------|-----------|-----------|
| Note playback | `play` event (JSON or binary) | Client -> Server |
| Parameter updates | `set_parameter` event | Client -> Server |
| Runtime parameters | `set_runtime_parameters` event | Client -> Server |
| Fix-MIDI velocity | `set_fix_velocity` event | Client -> Server |
| String excitation | `set_string_excitation` event | Client -> Server |
| Hammer shape | `set_hammer_shape` event | Client -> Server |
| Parameter acknowledgment | `param_ack` event | Server -> Client (push) |
| Lifecycle state | `lifecycle` event | Server -> Client (push) |
| Calibration progress | `calibration` event | Server -> Client (push) |
| MIDI playback progress | `midi_progress` event | Server -> Client (push) |
| Inbound MIDI events | `midi_note_event` event | Server -> Client (push) |
| MIDI monitor (every inbound message, raw hex) | `midi_message` event — see [below](#socketio-midi_message-server-client) | Server -> Client (push) |
| Engine errors | `engine_error` event | Server -> Client (push) |
| **State changes (SSOT I1)** | `state_changed` / `preset_changed` / `session_changed` / `domain_invalidated` / `engine_busy` | Server -> ALL clients (push) — see [State events](#state-events-ssot-i1) |
| Latency measurement + I2 liveness probe | `ping_ws` (acked; optional payload) / `pong_ws` | Bidirectional |
| Reconnect / gap handshake (I2) | `hello {clientId, boot, lastSeq}` → ack `{ok, boot, seq, events \| resync}` | Client -> Server (request/response) |
| Registry command (I4) | `command {name, args, …}` → ack `{ok, status, result, jobId?}` — see [Commands and jobs](#commands-and-jobs-i4) | Client -> Server (request/response) |
| Job lifecycle (I4) | `job_started` / `job_progress` / `job_finished` / `job_failed` / `job_cancelled` | Server -> ALL clients (push) |

**Binary frame format** for minimum-latency note input: 3 bytes `[command, pitch, velocity]`.

### State events (SSOT I1) {#state-events-ssot-i1}

**Every** mutation of preset / engine-visible / session state, from **every** source (FE tab, curl,
MCP, assistant, MIDI CC knob, calibration thread, auto-tuner, modal apply), goes through ONE write
machinery and is broadcast to **all** connected clients (dev-960f). Owners record after a successful
write; `pianoid_middleware/state_journal.py` (`JOURNAL`) is the sole owner of the sequence number, the
per-entry version, the replay ring buffer and coalescing, and emits on this socket.

| Write path | Machinery |
|---|---|
| preset parameters (`/set_parameter/*`, `/set_string_excitation/*`, `/set_hammer_shape/*`, `/excitation_energy`, calibration mass commits, auto-tuner, MIDI CC string knobs, sound-channel calibrator, every `Pianoid.update_*` facade, the stored deck feedback `store_feedback_coeff`) | `edit_commit.commit`: read-only guard (409 `preset_read_only`) → owner apply (`ParameterManager`, …) → Layer B edit policy → `state_changed`. Recorded whenever the model write completed, even if only the engine upload failed (logged); a raised error records nothing |
| runtime parameters (REST + WS `set_runtime_parameters`, HOT + FULL `/load_preset` slider carry-over, MIDI CC volume / feedback / deck-scaling knobs, the calibration volume auto-ranging, Layer B re-layering of the live `volume_center`) | `runtime_params.apply_runtime_parameters` (`output_level` for the re-layering) → `state_changed{domain:'runtime'}` |
| preset lifecycle (load / switch / spawn / promote / unload / save / library load, incl. `/modal/apply_to_preset`) | the library owners in `Pianoid` + the load / save routes → `preset_changed` |
| session state (fix velocity, excitation mode, MIDI, mic, limiter, synthesis pause, audio, …) | precise `session_changed` from the helper, else generic from the route class |
| Layer B `output_scale` (calibration, level-neutral compensation, stale flag) | `output_level.record` → `state_changed{domain:'output_level'}` |

**Route classification.** `pianoid_middleware/write_routes.py` classifies EVERY Flask endpoint and
socket.io event: `param` (precise `state_changed` from the choke point), `param_coarse` (preset data with
no fine key → `domain_invalidated{domain}` after a 2xx), `preset`, `session` (`session_changed{domain}`,
generic when the handler recorded no precise one), `transient` (`engine_busy` start/end), `action`
(playback / measurement, no event), `read_only`. `tests/unit/test_write_route_registry.py` fails on an
unclassified route (all socket.io namespaces) — a new write path cannot bypass the broadcast silently —
and scans EVERY module the backend loads for direct engine / model writes (C++ setters, `send_*_to_CUDA`,
runtime setters, `mp.*` / `physics.*` assignment, `sm.update_*`) outside the owner modules. Temporary
chart / test overrides go through `chartFunctions._engine_override`, which reports them to the safety net.
`param` routes (except the session-wide `runtime` / `output_level` domains) are rejected UP FRONT with
409 `preset_read_only` on a read-only original — a calibration job never reports `started` and then fails
in its worker thread. A CORS preflight (`OPTIONS`, answered by Flask-CORS without running the view) bypasses
all of this: no source context, no up-front 409, no fallback event (dev-fbcb: before the fix every browser
JSON POST to a `session` route — e.g. the Excitation hammer/bow toggle — also broadcast a keyless
`session_changed`, and a `param` route's preflight 409'd on a read-only original).

**Source attribution (client → server, optional, additive).** REST: headers `X-Pianoid-Source`
(`fe`·`rest`·`ws`·`mcp`·`assistant`·`calibration`·`midi_cc`·`modal`·`autotune`·`system`; the backend itself
stamps `undo` / `redo` on the writes a history replay makes — SSOT I3),
`X-Pianoid-Client` (per-tab id), `X-Pianoid-Op` (per-write op id), `X-Pianoid-Group` (one gesture /
command). WS write events (`set_parameter`, `set_string_excitation`, `set_hammer_shape`,
`set_runtime_parameters`, `set_fix_velocity`): payload fields `source`, `clientId`, `opId`, `groupId`.
Defaults: `rest` / `ws`; an unknown kind becomes `system`; a worker thread a request starts keeps that
request's `clientId` / `opId` / `groupId`. Some routes force the kind (calibration family
→ `calibration`, `/modal/apply_to_preset` → `modal`); worker threads record `calibration`, the MIDI
listener `midi_cc`, the auto-tuner `autotune`. Existing payloads, acks (`param_ack`, emitWithAck
returns) and responses are unchanged.

**Events (server → every client).** Common fields: `seq` (int, process-monotonic, +1 per emitted event
— a gap means a missed event), `ts` (epoch s), `source {kind, clientId?, opId?, groupId?}`.

| Event | Fields | Meaning / client action |
|---|---|---|
| `state_changed` | `entry`, `version`, `domain`, `keys`, `fields`, `after` (+ `opIds` when coalesced) | `domain` of library `entry` changed. `version` = per-entry counter, stamped at EMIT time: strictly +1 per emitted `state_changed` of that entry (a coalesced event takes the version of its emission), `0` for `entry null`. `keys` = the addressed key numbers (see key spaces below; field NAMES for `runtime`). `fields` = edited field names (`string`/`mode`/`hammer`/`excitation_energy`), else `null`. `after` = the STORED values of exactly `keys` in the `GET /get_parameter/<domain>/<key>` shape (`{"57": [..]}`), or `null` → refetch the domain |
| `preset_changed` | `kind`, `entry`, `version` (the entry's current version) | `kind` ∈ `load_full` · `load_hot` · `load_structural` · `switch` · `spawn` · `promote` · `unload` · `save` · `library_load`; `entry` = the entry it concerns (the ACTIVE one for load / save / switch). `load_full` / `load_structural` / `switch` / `unload` replace editor data (today's `presetVersion` bump); `load_hot` keeps it; `save` / `promote` / `spawn` / `library_load` change only the library list |
| `session_changed` | `domain`, `keys`, `after` | session state outside the preset: `fix_velocity` (`after {enabled, level}`), `excitation_mode` (`keys [pitch]`, `after {pitch: 0 hammer / 1 bow}`), `midi`, `mic`, `limiter`, `synthesis`, `audio`, `calibration_job`, `lifecycle` (`after null` → refetch) |
| `domain_invalidated` | `domain` | coarse: refetch the domain. Either a `param_coarse` route (`calibration_curve`, `calibration_reference`, `calibration_params`) or the **I1b safety net**: a GPU upload group that no precise event covered — `deck` (→ `feedin`, `feedback`, `*_mask`, `sound_channel*`, `string_sound_channel`), `string`, `hammer`, `excitation`, `mode`, `excitation_coeffs` (→ `excitation_energy`), `runtime` (→ `GET /get_runtime_parameters`). The backend log names the uncovered call site (`[journal] WARNING …`) |
| `history_changed` | `entry`, `can_undo`, `can_redo`, `undo` / `redo` (labels, latest first, <=20), `undo_domains` / `redo_domains`, `depth` | the undo history of `entry` changed (a recorded edit, an undo / redo, a clear on load / unload) or the active entry switched — the same payload as `GET /history` (SSOT I3). A HINT outside the state-event stream: no `seq` / `version`, not replayed by `hello` (clients re-read `GET /history` on reconnect) |
| `engine_busy` | `phase` `start`/`end`, `reason` (endpoint) | a `transient` route (offline chart render, `/start_test`, `/audio/session`, `/synthesis_measure`) temporarily overrides the engine and restores it; no state event follows |

`state_changed` domains = the REST parameter names verbatim (same-name rule): `string` (also `physics`
writes), `mode`, `hammer`, `gauss`, `excitation`, `string_excitation_curves`, `feedin`, `feedback`,
`feedin_mask`, `feedback_mask`, `sound_channel`, `sound_channel_mask`, `string_sound_channel`,
`excitation_energy` (`after {hammer_mass: {pitch: kg}, hammer_speeds?, excitation_impulse_calibration?}`),
`runtime` (`entry null`, `keys` = updated field names, `after` = the `updated` ack dict, bare units —
`amplitude_gate_enabled` as `0`/`1` there, a bool on `GET /get_runtime_parameters`;
also `deck_scaling` = the MIDI CC deck-scaling override, `effective_volume_center` = the Layer B re-layer),
`deck_feedback_coefficient` (the PER-PRESET stored feedback baseline, `entry` = active, `keys []`,
`after {deck_feedback_coefficient}`; written by `store_feedback_coeff`),
`output_level` (`keys []`, `after {output_scale, calibrated, target_dbfs}`).

**`after` contract.** Stored values only — never an effective value: a mask edit carries the mask
domain (the raw row is untouched); `hammer` carries stored `hammer_width` plus the read-only
`hammer_width_effective` / `hammer_radius`; `string` carries the derived `tail` (= `length`/10) read-only.
`after` is omitted (`null`) when more than 16 keys were edited (e.g. `key_no=all`) and for
`string_excitation_curves` — the client refetches that domain / pitch.

**Ordering, coalescing, replay.** Events are emitted in `seq` order from an ordered outbox drained
outside the journal lock (a slow socket never blocks a recording writer) and outside `cuda_lock` (the
synth thread is never stalled by a socket). Events with the same `(event, domain, entry, source.kind,
clientId)` within **30 ms** are coalesced: the first is emitted at once, the rest of the window is
merged into ONE event (`keys`/`fields` union, `after` merged, `opIds` list). A request that touches
nothing emits nothing (a hammer GET → POST identity is not an edit). The journal keeps the last 2000
events (`JOURNAL.since(seq)`).

### Undo / redo (SSOT I3) {#undo--redo-ssot-i3}

Every edit made through the write machinery (`edit_commit.commit`) — from ANY source: the editors, REST / MCP /
the assistant, calibration passes, MIDI CC — records an undo STEP: the STORED values of exactly the edited keys
before and after, in the GET shape the parameter POST accepts (`undo_history.py`). Steps of one write context
(one REST request / WS event / worker thread — e.g. a whole Calibrate Synthesis pass) or one explicit
`X-Pianoid-Group` / WS `groupId` form one GROUP = one undo unit; a batch / multi-pitch / whole-keyboard edit is
one commit = one step; `midi_cc` streams on the same domain + keys within 1 s merge. A write that changes nothing
stored records no step. The feedback deck is scoped for the domain filter: rows >= 128 (the Sound-Channels
strings axis) match `feedback@output` / `feedback_mask@output`, piano rows `feedback@piano` /
`feedback_mask@piano` (plain `feedback` matches both).

| Route | Body | Result |
|---|---|---|
| `POST /history/undo` | `{"domains": [...]}` optional | reverts the latest group of the ACTIVE library entry, or the latest group touching `domains` (an editor's own Undo). 200 `{entry, label, steps, can_undo, can_redo, undo, redo, ...}`; 409 `history_empty` / `history_conflict` (a LATER group changed one of the same `(domain, key)` — undo that first) / `history_irreversible` (a step whose `before` could not be captured completely) / `preset_read_only` (the active entry is an original, up front) |
| `POST /history/redo` | same | re-applies the latest undone group (same filter / codes) |
| `POST /history/undo` / `redo` with `{"group": "<id>"}` | (assistant v2 P2, dev-4324) | only the latest group with that explicit `X-Pianoid-Group` / WS `groupId` id (the assistant's auto-revert and its Undo per action); combinable with `domains`; same 409 codes (`history_empty` when that group has nothing left); 400 for an empty / non-string id |
| `GET /history` | — | `{entry, can_undo, can_redo, undo, redo, undo_domains, redo_domains, undo_groups, redo_groups, depth}` (= the `history_changed` payload; `undo_groups` / `redo_groups` = the explicit group id of each listed group, `null` for an implicit one) |

- The inverse runs THROUGH the machinery (`Pianoid.apply_parameter_request` -> `edit_commit.commit`: read-only
  guard, Layer B policy, `state_changed`) under source kind `undo` / `redo`, so every open editor follows like
  any other change (I2; the initiating tab too — `undo` is not an optimistic `fe` write). A replay records no
  history. A new group clears the entry's redo stack.
- One linear undo + redo stack PER LIBRARY ENTRY, global across sources and clients. Cleared on `preset_changed`
  `load_full` / `load_structural` (all entries) and `unload` (that entry); kept across `switch` (and announced
  for the switched-to entry); bounded to 200 groups per entry and a 64 MB estimate overall (oldest first).
- Undoable domains: `string` (also `physics`), `mode`, `hammer`, `gauss`, `excitation`, `string_excitation_curves`,
  `feedin`, `feedback`, `feedin_mask`, `feedback_mask` (a mask undo restores the mask, never the raw row),
  `sound_channel`, `sound_channel_mask`, `string_sound_channel`, `excitation_energy`, `deck_feedback_coefficient`
  (the stored "Set" baseline). NOT undoable (`undo_history.EXEMPT`): `runtime` live sliders, `output_level` (re-run
  the calibration), session state, preset lifecycle, coarse calibration data. `tests/unit/test_undo_history.py`
  fails on a journaled domain that is neither.
- Measured: every undoable domain round-trips bit-exact through REST (`tests/integration/test_undo_routes.py`).
  Exception: a legacy SUB-FLOOR stored hammer width is floored by any real hammer edit (Basic `Hammer` A1), so it
  cannot be restored (the rendered shape is identical). The `note_playback` render after edit + undo matches the
  pre-edit render within the render's own run-to-run noise (~2e-4 relative: the offline render is not
  bit-deterministic and an upload lands at the next cycle boundary).

**Reconnect protocol (I2, dev-fbcb).** On every (re)connect — and whenever a client sees a `seq` gap — it
sends `hello {clientId, boot, lastSeq}` and the ack is either `{ok, boot, seq, events: [{event, payload}, …]}`
(every event after `lastSeq`, in order, from the ring) or `{ok, boot, seq, resync: true}` (first contact, a
different `boot` = the backend process restarted and `seq` started over, or `lastSeq` outside the ring) — the
client then refetches. `boot` is a per-process id (`backendServer.JOURNAL_BOOT`). The FE also probes liveness
with an acked `ping_ws` every 5 s; two unanswered probes = a half-open socket → forced reconnect → `hello`.
(`ping_ws` with a payload used to raise `TypeError` server-side — no ack, no `pong_ws` — fixed dev-fbcb.)
Verified live (dev-fbcb): REST write → open editor p50 86.6 / p95 96.5 ms (50 runs; server part 4 ms, the
rest is the page's re-render); an edit in one tab shows in a second tab with exactly one backend write;
offline 12 s → replay; backend suspended 15 s (half-open) → probe-forced reconnect; backend killed +
restarted → resync. Every editor domain is mirrored, plus the runtime surface (volume slider, volume
sensitivity `volume_center`/`volume_range`, feedback slider position from the EFFECTIVE `feedback_coeff` /
`feedback`, the stored baseline), `excitation_mode` and `output_level` (read-only in the Synth chip
tooltip) — measured live: each foreign REST write showed in the open control == the backend GET, zero FE
writes; a fresh tab hydrates all of them from the GETs.

Verified (dev-960f, live :5002 + python-socketio client): every write path → exactly the listed
event(s), seq gapless; `tests/integration/test_state_events.py` (18 paths, no emit by a thread holding
`cuda_lock`); `tests/unit/test_state_journal.py`.

### Commands and jobs (I4) {#commands-and-jobs-i4}

One declarative **command registry** fronts the routes, so the UI, REST, WS, curl, MCP and the assistant make
literally the same call (dev-6026; design: `docs/development/command-layer-i4-design-2026-10-14.md`).

**Registry.** PianoidInstall `schemas/commands/<family>.json` (families `playback`, `preset`, `render`,
`param`, `history`, `calibration`, `modal`, `job`, `launcher`). Each command: `name` (`play.note`,
`preset.save`, `render.note_playback`, `param.set`, `calibration.synthesis`, `modal.run_stage`, `job.cancel`,
…), `target` (`backend` · `modal` · `launcher` · `ui`), `tier` (`read` · `ui` · `act` · `write` ·
`destructive` · `excluded`, the assistant envelope tier of the parent proposal §4.1; UI / REST callers may
run every tier, `excluded` is never exported as a tool), `long_running`, `doc` (the MkDocs anchor of the
wrapped route), `route` and the `args` / `result` JSON Schemas. `route` = `{method, path, fixed?,
body_arg?}`: `{arg}` path placeholders are filled from the args, `fixed` values are merged into the body
(e.g. `play.keyboard` = `/play_keyboard {mode: "online"}`, `render.keyboard` = `{mode: "offline"}`),
`body_arg` makes one arg the whole body (`param.set` → `values`), the other args are the JSON body (the
query string for a GET). Core reads `$PIANOID_COMMANDS_DIR`, else `<PianoidInstall>/schemas/commands`;
a missing registry fails the backend import (fail fast). A registry that is **newer than the backend** (a backend command whose route this Core lacks, e.g. only PianoidInstall was pulled) does not fail: that command is skipped with one `command registry: N backend command(s) have no route on this backend` warning (`Registry.unrouted`), and the per-route job hook never raises. Before dev-c6b6 (2026-10-21) the hook's `url_map.match` raised NotFound and every route answered 404, `/health` included. The schemas use a declared draft-07 subset
(`type`, `properties`, `required`, `additionalProperties`, `enum`, `const`, `minimum`, `maximum`,
`minItems`, `maxItems`, `items`, `oneOf` + annotations): Core validates with `jsonschema`, the frontend
with `utils/commandSchema.js`, and both run the shared `schemas/commands/_conformance.json` cases.

| Route / event | Body | Result |
|---|---|---|
| `POST /command/<name>` | the command's args | `{ok, status, result, jobId?}` (`error` on failure); the HTTP status is the wrapped route's. 400 `invalid_args {details: [{path, message}]}` before any dispatch; 404 `unknown_command`; 409 `wrong_target` (a `launcher` / `ui` command); 503 `modal_unavailable` |
| WS `command` (acked) | `{name, args, source?, clientId?, opId?, groupId?}` | the same object as the ack |
| `GET /commands` | — | `{commands: [<registry records + family>], families}` |
| `GET /commands?format=tools` | — | `{tools: [{name, description, input_schema}]}` — Anthropic tool definitions (dots → `__`, tier and long-running in the description, `excluded` left out; the `ui` family included — it runs through the launcher relay) |
| `POST :3001/api/command/ui.<…>` (launcher) | the `ui` command's args | relayed to the LEADER tab (I5): `{ok, status, result}`; 503 `no_leader_tab`, 504 `ui_timeout`, 429 `rate_limited`, 423 `blocked_by_user` — see [Tunner UI commands](../pianoid-tunner/OVERVIEW.md#ui-commands-i5-dev-c491). `POST /command/ui.*` on :5000 is 409 `wrong_target` |
| `GET /command_names` | — | DEPRECATED (`{"commands": ["volume"]}`), superseded by `GET /commands` |

**Execution = re-dispatch of the existing route.** A backend command runs the wrapped Flask route
in-process (`command_registry.dispatch_route`: a fresh app context + `test_request_context` +
`full_dispatch_request`), with the caller's source as the `X-Pianoid-*` headers (REST: passed through,
default `rest`; WS: the payload fields, default `ws`; the frontend bus sends `fe`). The journal hooks, the
`write_routes` classification, the read-only guard and the error handlers therefore run exactly as for a
direct call: the same command via the route, `/command` or WS `command` produces identical journal entries
except `source` (`tests/integration/test_command_contract.py`), and one command is one undo group.
`/command` and WS `command` themselves are classified `action`. A `modal` command is forwarded to the modal
adapter (`$PIANOID_MODAL_URL`, default `http://127.0.0.1:5001`) with the same body.

**Jobs** (`job_manager.py`, `command_routes.py`). A long-running command returns `jobId` at once (also added
to the wrapped route's own JSON response) and the job reports to ALL clients. `job.get {jobId, wait_s}` (dev-431a):
`wait_s` > 0 (≤ 60) answers when the job ends or after that many seconds, so one call follows a long step (a
PolyMAX fit takes minutes; the rig steps report per-band / per-session progress in `pct` / `msg`):

| Event | Payload |
|---|---|
| `job_started` | `{job}` |
| `job_progress` | `{jobId, pct, stage, msg}` (≤ 10 Hz per job) |
| `job_finished` | `{jobId, result, job}` |
| `job_failed` | `{jobId, error, job}` |
| `job_cancelled` | `{jobId, result, job}` |

`job` = `{id, name, family, state (pending · running · finished · failed · cancelled), pct, stage, msg,
result, error, started_at, finished_at, source}`. The events are unsequenced UI hints (like
`history_changed`); a reconnecting client re-reads `job.list` (the newest 50 jobs). Jobs are created **per
route**: a request to the route of a long-running command opens a pending job before the view runs and
accepts it after a 2xx (an error status drops it), so a job also exists when an old panel or curl calls
the route directly. The family adapters (one active job per family):

| Family (commands) | Progress | End | `job.cancel` → |
|---|---|---|---|
| `calibration` (`calibration.synthesis`, `calibration.acoustic`) | the `calibration` progress emitter (`progress` × 100, `step`, `message`) | the worker's return value (`job_finished`) or exception (`job_failed`) | `calibration.cancel` |
| `modal` (`modal.run_stage`) | `:5001 GET /modal/status` polled every 0.5 s (`current_point / total_points`) | status `done` / `error`; a stage answering without `task_id` ran synchronously and its response is the result | `modal.cancel` |
| `midi_playback` (`play.midi_file`) | `get_online_midi_playback_status()` polled every 0.5 s | `complete` / playback inactive | `play.midi_file_stop` |

A cancelled job ends as `job_cancelled` with the partial result. Measured live (dev-6026, worktree stack, two tabs): the UI's Calibrate Synthesis
(an old panel calling the route directly) → `job_started` + 84 `job_progress` + `job_finished`, one undo group,
and the second tab's job store showed it finished; `calibration.synthesis` via WS `command` (source `assistant`)
+ `job.cancel` after 5 progress events → `job_cancelled` 6 pitches in, then `history.undo` restored every stored
hammer mass byte-identically. `play.note` through WS `command` vs the raw `play` event (ack round trip, 200 note-offs,
3 runs): added p50 0.53–0.59 ms, added p95 0.64–0.79 ms. The old channels (`calibration`,
`midi_progress`, `/calibration_status`, `/modal/status`) are unchanged.

**Dependencies:** `flask-socketio>=5.3`, `python-socketio>=5.10` (backend); `socket.io-client@^4.7` (frontend).

**Configuration:** `async_mode="threading"` for cuda_lock compatibility. `cors_allowed_origins="*"` for localhost deployment. Server started via `socketio.run()` instead of `app.run()`.

---

## Endpoint Categories

### backendServer.py (port 5000)

```
  /ping                     -- connectivity check
  /health                   -- lifecycle status
  /get_settings             -- UI boot settings
  /load_preset              -- initialize engine
  /save_preset              -- persist preset
  /reset                    -- reset engine state
  /commands                 -- command registry (I4); ?format=tools = tool definitions
  /command/<name>           -- run a registry command (I4)
  /command_names            -- DEPRECATED, superseded by /commands
  /graph_names              -- chart and action type catalogue
  /get_parameter/<p>/<k>    -- read simulation parameters
  /set_parameter/<p>/<k>    -- write simulation parameters
  /set_string_excitation/<pitch>  -- write single-level excitation curves
  /set_hammer_shape/<pitch>       -- write hammer geometry (delegates to dispatcher)
  /set_fix_velocity         -- enable/disable Fix-MIDI velocity clamp (POST)
  /get_fix_velocity         -- read current Fix-MIDI clamp state (GET)
  /set_excitation_mode      -- set a pitch's excitation type hammer/bow (POST)
  /get_excitation_mode      -- read every preset pitch's excitation type (GET)
  /set_runtime_parameters   -- volume / feedback at runtime
  /play                     -- trigger note on/off
  /play_mode/<mode_no>      -- trigger mode playback
  /play_keyboard            -- full-keyboard sweep (online+mic capture / offline render)
  /midi_playback            -- MIDI file playback control
  /midi_player/*            -- MIDI-file player: status, library, load, transport, seek, options, mute (dev-6f0c)
  /playback_stats           -- EventQueue statistics
  /pause_synthesis          -- pause synthesis cycle (keeps GPU)
  /resume_synthesis         -- resume synthesis from pause
  /audio/reopen             -- close + re-open the requested audio driver (dev-19be)
  /debug/audio_fault        -- TEST HOOK: inject ASIO reset request / callback stall (dev-19be)
  /audio/devices            -- ASIO host snapshot: driver, sr, buffer, latencies, channel names/types (dev-1b6c)
  /audio/session            -- sample-locked ASIO play_record / record / play measurement (dev-1b6c)
  /get_available_notes      -- list pitches in preset
  /get_string_map           -- string layout data
  /get_block_map            -- block-to-string mapping
  /capture                  -- force result extraction
  /get_chart_test           -- render a chart
  /start_test               -- execute an action
  /shutdown                 -- graceful shutdown (free GPU, stop Flask)
  /calibrate_volume         -- multi-velocity calibration (mic, background)
  /measure_rms              -- measure RMS for a single pitch (mic)
  /equalize_keyboard        -- equalize volume across keyboard (mic, background)
  /tune_note                -- iteratively tune a pitch to target dB (mic)
  /calibration_status       -- poll calibration progress
  /calibration_cancel       -- cancel running calibration
  /calibration_params       -- GET/POST perception curves, timing bands, level multipliers
  /mic_devices              -- list microphone input devices
  /set_mic_device           -- select microphone input device
  /preset/list              -- list library entry records + active preset
  /preset/load              -- load preset to GPU library as a read-only original
  /preset/switch            -- switch active preset (double-buffer swap)
  /preset/unload            -- remove preset from GPU library
  /preset/spawn_working_copy -- spawn an editable working copy from an entry
  /preset/promote           -- promote a working copy onto its original's JSON file
```

### modal_adapter_server.py (port 5001)

On startup, the server runs a stale process check: finds any PID listening on the configured port via `netstat`, verifies it is a Python process running `modal_adapter_server` via WMIC, and kills only confirmed stale instances before binding.

```
  /health                   -- lifecycle status
  /shutdown                 -- graceful shutdown
  /open_folder_dialog       -- native OS folder picker (tkinter subprocess)
  /modal/defaults           -- pipeline defaults shared with frontend
  /modal/data_status        -- pipeline stage availability flags
  /modal/run_pipeline       -- run full extraction pipeline (background)
  /modal/load_folder        -- load impulse response measurements
  /modal/upload_measurements -- upload measurement arrays
  /modal/measurement_info   -- measurement metadata
  /modal/mapping            -- set excitation-to-pitch mapping
  /modal/esprit_config      -- GET/POST ESPRIT config (persists to config.json)
  /modal/band_presets       -- GET built-in + user-saved band preset listing
  /modal/band_presets/save  -- POST save current band config as named user preset
  /modal/band_presets/<n>   -- DELETE remove a user-saved band preset
  /modal/gpu_status         -- check CuPy GPU availability
  /modal/run_esprit         -- launch ESPRIT extraction (background)
  /modal/status             -- poll ESPRIT progress
  /modal/results            -- get extraction results
  /modal/apply_to_preset    -- inject modes into active preset
  /modal/cancel             -- cancel running extraction
  /modal/run_frf            -- (Phase 1, dev-frf-q-phase01) spectral FRF
                               extraction with hammer-impact force window
                               from raw_recordings/ per scenario
  /modal/frf/summary        -- (Phase 1) project-level FRF index + per-scenario
                               metadata (lightweight, safe before any run)
  /modal/frf/scenario/<idx> -- (Phase 1) per-scenario FRF arrays serialised
                               for the frontend (frequencies + per-channel
                               magnitude_db / magnitude_abs / phase_deg /
                               coherence)
  /modal/frf                -- (Phase 1, DELETE) invalidate FRF — remove
                               persisted files + clear in-memory state
  /modal/qc/log_decrement   -- (Phase 0c) GET + POST Hilbert log-decrement
                               Q cross-check; flags chains where Q_logdec
                               disagrees with Q_esprit beyond threshold
                               (default 30%)
  /modal/run_modal_mass     -- (Phase 2, dev-modal-mass-p2) per-chain residue
                               extraction (SDOF circle-fit + MDOF RFP) +
                               SVD dual-unit-max inversion -> per-mode
                               relative modal mass + mass-normalised
                               shapes. Q6 gate: requires >=8 scenarios
                               with FRF persisted.
  /modal/modal_mass/summary -- (Phase 2) project-level modal-mass index
                               (chain count, m_rel/m_abs, reference mode)
  /modal/modal_mass/mode/<chain_id> -- (Phase 2) per-chain payload (shapes
                               + per-(scenario, channel) residues)
  /modal/modal_mass         -- (Phase 2, DELETE) invalidate modal mass —
                               remove persisted files + clear cache
  /modal/projects           -- list projects, current project, projects_base
  /modal/projects/create    -- create project with optional measurement_source (v1)
  /modal/projects           -- (POST) v2 create from a Measurement (snapshots setup, N5)
  /modal/projects/<old>/branch -- v2 branch a sibling Project off the same Measurement
  /modal/projects/open      -- open existing project
  /modal/projects/copy      -- RETIRED (410 Gone, Phase 2c) -> use /projects/<old>/branch
  /modal/projects/create_from_zip -- RETIRED (410 Gone, Phase 2c) -> POST /modal/projects
  /modal/projects/delete    -- delete project
  /modal/projects/add_measurements -- add measurements to current project
  /modal/projects/set_base  -- set projects base directory
  /modal/projects/export    -- download project as .pianoid-project zip
  /modal/projects/export_info -- preview export size and stage completeness
  /modal/projects/import    -- upload and import .pianoid-project zip
  /modal/projects/<name>/effective_signal_length -- (dev-qc01) per-scenario per-channel
                                                    Effective Signal Length QC (GET) +
                                                    recompute (POST). dev-qc02 added
                                                    qc_threshold body field (default 0.1).
  /modal/projects/<name>/qc_curves -- (dev-3151) interactive QC curves for one
                                      (scenario, channel) — signal_a / signal_b /
                                      env_signal / env_diff / ratio + T_eff at the
                                      requested threshold. Backs QCVisualizationPanel.
  /modal/collect/*          -- RETIRED (410 Gone, Phase 2a) -> /modal/measurements/<id>/collect/*
                               (the v1 B-0/B-1 surface; see Measurement Collection Endpoints below)

  -- Measurement entity (v2, Phase 1+2; canonical doc: MODAL_COLLECTION.md) --
  /modal/measurements              -- GET list / POST create (409 dup name N1)
  /modal/measurements/<id>         -- GET full manifest + setup/* / DELETE (409 if linked, N6)
  /modal/measurements/<id>/audio_config       -- PATCH (423 if locked, N4)
  /modal/measurements/<id>/impulse_config     -- PATCH (423 if locked)
  /modal/measurements/<id>/series_config      -- PATCH (423 if locked)
  /modal/measurements/<id>/mapping_config     -- PATCH (423 if locked)
  /modal/measurements/<id>/calibration_criteria -- PATCH (always allowed; analysis-time gate)
  /modal/measurements/<id>/setup_test         -- POST run / GET latest (N3, overwrite-per-run)
  /modal/measurements/<id>/unlock             -- POST manual unlock-with-warning (confirm:true)
  /modal/measurements/<id>/rename             -- POST atomic rename + cross-ref update
  /modal/measurements/<id>/collect/start      -- (Phase 2c) start one scenario
  /modal/measurements/<id>/collect/status     -- (Phase 2c) session snapshot + messages ring
  /modal/measurements/<id>/collect/cancel     -- (Phase 2c) cancel in-flight scenario
  /modal/measurements/<id>/collect/results/<sid> -- (Phase 2c) completed scenario result
  /modal/measurements/<id>/devices            -- ASIO channel tables via :5000 /audio/devices (dev-4284)
  /modal/measurements/devices                 -- (Phase 2c) unscoped alias (Create flow)
  /modal/measurements/active_session          -- global "any session in flight?" probe (sole v1 survivor)
  /modal/measurements/probe                   -- (import) sniff a folder's layout, no writes
  /modal/measurements/import_folder           -- (import) create a Measurement from a folder
  /modal/measurements/<id>/import_scenarios   -- (import) add scenarios to an existing Measurement
  /modal/measurements/unzip_helper            -- (import) extract a raw zip into _staging/
  /modal/fs/roots, /modal/fs/list             -- (import) server-side directory tree picker
```

---

## Lifecycle Endpoints

### Lifecycle serialisation (dev-2d06)

Preset lifecycle operations destroy / rebuild the engine, so they **never run concurrently** with each
other or with a request that uses the engine. Owner: `pianoid_middleware/engine_lifecycle.py`
(`EngineGate`, one instance `_ENGINE_GATE` in `backendServer.py`).

| Request class | Routes | While a lifecycle op runs |
|---|---|---|
| **Lifecycle op** (exclusive) | `POST /load_preset` (all reinit kinds), `/preset/load`, `/preset/switch`, `/preset/unload`, `/preset/spawn_working_copy`, `/recalibrate_output_level`, `/shutdown` | **identical** request (same route + same JSON body) → waits and returns the in-flight result with `"coalesced": true` (only `/load_preset` and `/preset/switch` coalesce); anything else → **`409`** `{"error": "LifecycleBusy", "code": "load_in_progress", "message", "in_progress": {"op", "running_for_s"}}` |
| **Engine use** (shared) | every other HTTP route + the engine Socket.IO events (`play`, `set_parameter`, `set_string_excitation`, `set_hammer_shape`, `set_runtime_parameters`, `set_fix_velocity`) | refused at once: HTTP **`503`** `{"code": "lifecycle_in_progress", "in_progress": {...}}`; a WS event acks `{"ok": false, "code": "lifecycle_in_progress"}` |
| **Never gated** | `GET /health`, `/ping`, `/get_settings`, `POST /bug_report`, `GET /bug_reports`, `POST /bug_reports/<id>/status`, CORS `OPTIONS` | `/health` answers `200` with `"status": "loading"` + `"lifecycle_op"` built from Python-level state only (never dereferences the engine being built / destroyed) |

A lifecycle op first waits for in-flight engine requests to finish (≤ 30 s, else `409` `engine_busy`);
new engine requests are refused while it is pending. **Why 409, not a queue:** a queued *different*
load would destroy the engine the first one just built — last-writer-wins on a destructive op is exactly
the multi-tab interference; the caller decides whether to retry. Once a load completes, an identical
re-load classifies `hot` (no destroy), so late duplicates are harmless.

Incident (2026-10-10): several open frontend tabs each auto-loaded the last preset when the backend
started; Werkzeug ran the loads on concurrent threads and one load's `destroyPianoid()` tore down
another's fresh engine → `0xC0000374` / `0xC0000005`. Regression tests:
`tests/unit/test_engine_lifecycle_gate.py`; live repro `docs/development/diagnostics/dev-2d06-concurrent_load_repro.py`.
The frontend additionally elects ONE tab leader that performs automatic loads
([pianoid-tunner OVERVIEW → Tab leadership](../pianoid-tunner/OVERVIEW.md#tab-leadership-dev-2d06)).

`PIANOID_BACKEND_PORT` (env, default `5000`) moves the backend to another port — agents use it with the
launcher's `PIANOID_LAUNCHER_PORT` / `PIANOID_BACKEND_PORT` / `PIANOID_MODAL_PORT` / `PIANOID_CORE_DIR` for an isolated stack
that the user's open `:3000` tabs never see (the launcher starts `modal_adapter_server.py --port $PIANOID_MODAL_PORT`).

---

### `GET /ping`

Simple connectivity check. No pianoid required.

Response `200`:
```json
{
  "message": "pong",
  "timestamp": 1710000000000.0
}
```

---

### `GET /health`

Returns the full lifecycle state of the engine. Safe to call before a preset is loaded.

Response `200` (not started):
```json
{
  "timestamp": 1710000000000.0,
  "pianoid_loaded": false,
  "backend_thread_running": false,
  "exception": false,
  "gpu_available": true,
  "status": "not_started",
  "message": "Flask server running, core not loaded",
  "lifecycle": {
    "gpu_initialized": false,
    "audio_driver_active": false,
    "main_loop_should_continue": false
  }
}
```

`gpu_available` (top-level, added dev-cudaguard 2026-06-10): a cached CuPy device probe (mirrors
`/modal/gpu_status`) — `true` iff a usable CUDA device is present. Reported even before a preset is
loaded (`pianoid_loaded: false`) so the frontend can disable APPLY + show a limited-mode warning
**before** a doomed load. When `false`, `POST /load_preset` is gated (HTTP `503 GpuUnavailable` —
see below) because the GPU synthesis engine cannot initialise. Real CPU synthesis is a deferred
feature (`docs/proposals/no-cuda-cpu-synthesis-2026-06-10.md`).

Response `200` (healthy):
```json
{
  "timestamp": 1710000000000.0,
  "pianoid_loaded": true,
  "backend_thread_running": true,
  "exception": false,
  "listen_mode": false,
  "single_deck_matrix": true,
  "stored_feedback_coeff": 1.0,
  "status": "healthy",
  "message": "Core loaded, GPU initialized, main loop running with audio",
  "lifecycle": {
    "gpu_initialized": true,
    "audio_driver_active": true,
    "main_loop_should_continue": true
  },
  "cpp_module_responsive": true,
  "available_notes_count": 88,
  "audio_driver_fallback": {
    "occurred": true,
    "requested": "ASIO_CALLBACK",
    "active": "SDL3",
    "reason": "Requested ASIO audio driver could not be initialized (ASIO driver initialization failed — no working ASIO device found ('UMC1820' skipped: 8 outputs < 10 needed (engine channels / output map))). Falling back to SDL3.",
    "skipped": ["'UMC1820' skipped: 8 outputs < 10 needed (engine channels / output map)"],
    "message": "ASIO_CALLBACK unavailable - using SDL3 ('UMC1820' skipped: 8 outputs < 10 needed (engine channels / output map))"
  }
}
```

Status values: `not_started`, `healthy`, `idle`, `degraded`, `error`, `partial`, `crashed`.
`degraded` / `error` (dev-19be) come only from the audio-driver watchdog (`audio_health`
below); they never downgrade a worse status. The frontend treats `degraded` like `healthy`
for engine-state purposes (synthesis still runs).

- `audio_health` (added dev-19be, 2026-10-09): the engine's audio-driver watchdog snapshot
  (`Pianoid.getAudioHealth()`, `pianoid_middleware/audio_health.py`), `null` before a preset
  loads or on an older binary. Fields: `state` (`ok` · `stalled` / `reset_requested` /
  `recovering` · `fallback` · `failed`), `message` (current fault), `last_fault`,
  `last_recovery` (e.g. `"re-opened ASIO_CALLBACK"`, `"ASIO could not be re-opened (...); fell
  back to SDL3"`), `ms_since_last_fault`, `ms_since_last_cycle` (synthesis-loop heartbeat),
  `ms_since_last_callback` (audio-callback heartbeat), `produce_timeouts`,
  `consecutive_produce_timeouts`, `asio_reset_requests` / `asio_resync_requests` /
  `asio_latency_changes` / `asio_buffer_size_changes` (process-cumulative asioMessage
  counts), `recovery_count`, `recovery_failures`, `recovery_pending`, and **`alert`**
  (`null` or `{level, message}` — what the frontend Audio chip renders). Status mapping:

  | Engine condition | `status` | `message` starts with |
  |---|---|---|
  | `stalled` / `reset_requested` / `recovering` | `degraded` | `Audio output interrupted - …` |
  | `fallback` (recovered onto SDL3 after a fault) | `degraded` | `Audio not on the requested device - …` |
  | `failed` (no driver could be opened; retried with backoff) | `error` | `Audio output failed - …` |
  | loop should run but `ms_since_last_cycle` > 5000 | `error` | `Synthesis loop not cycling for …` (+ queued event count) |

  A stall is reported after 400 ms and recovered after 1 s, so with a quick successful
  recovery `/health` may never show `degraded` — the episode stays visible as
  `recovery_count` / `last_fault` / `last_recovery` (Audio chip tooltip). Engine mechanics:
  [AUDIO_DRIVERS.md — Driver Fault Watchdog](../pianoid-cuda/AUDIO_DRIVERS.md#driver-fault-watchdog--recovery-dev-19be).

- `listen_mode`: the engine's runtime **listen-to-modes** flag — `true` when sound channels carry mode forces, `false` when they carry string bridge displacement. Mirrors the `listen_to_modes` value passed to the last `POST /load_preset` (its sole owner is `pianoid.mp.listen_to_modes`, set in `pianoid.py`). It is **not** the MIDI-listener state (`GET /midi/status` → `listening`); the two are independent. (Fixed in dev-lmode, 2026-06-05: this field formerly read `pianoid.listen`, the MIDI-listener loop flag, so it always reported `false` under the `listen_to_midi=0` default regardless of the modes setting.)

- `single_deck_matrix` (added dev-fbsl, 2026-06-05): the engine's compile-time `USE_SINGLE_DECK_MATRIX` mode. `true` (the active build) means there is ONE packed coupling matrix (feedin only) and feedback is derived as `feedin × deck_feedback_coeff` — no separate feedback half exists, so the per-pitch feedback MATRIX editor is meaningless and the frontend disables it (only the toolbar Feedback coefficient slider acts on feedback). Surfaced from the backend (not a frontend-only assumption) to avoid silent divergence. NOTE: the installed `.pyd` does not currently export the constant, so the backend falls back to `true` (the active build is single-deck per the pack/kernel path); if a future build exports `pianoidCuda.USE_SINGLE_DECK_MATRIX`, the field reflects it.

- `output_scale` (added dev-0da4, 2026-10-06): the active preset's Layer B output level — `{value, calibrated, stale, warning}`. `value` = `mp.output_scale` (the per-preset linear scale layered onto `volume_center`); `stale` = `!output_scale_calibrated || !settings_match` (a shape edit or preset genesis cleared the flag, or the stored scale was measured at other load settings; the stored value stays in use until the next full load or `POST /recalibrate_output_level`); `settings_match` / `load_settings` / `calibrated_load_settings` = the R5 load-settings key (dev-e772); `last_calibration` = `{previous_value, value, change_db, load_settings, time}` of the last committed calibration of THIS preset (`change_db` = its level jump); `reference_impulse` / `impulse` / `impulse_level_db` = the calibration's p60 v127 impulse reference, the current one and `20·log10(impulse/reference)` (the deliberate mass/speed/c level change, dev-5852); `target_dbfs` / `target_source` = the dBFS p60 v127 is calibrated to @ slider 64 and whether it is the preset's own `output_scale_target_dbfs` (`preset`, chord headroom, dev-0ccf) or the engine default −2 dBFS (`default`); `warning` = why the last calibration attempt on THIS preset kept the stored value (e.g. `"realtime engine is live - offline render refused …"` after a library switch). See [Layer B output level](#layer-b-output-level-output_scale).

- `mode_layout` (added dev-d0b7, 2026-10-11, 4000-modes T5): `{num_modes, flat_tier}` of the active preset — `flat_tier` = `[start, stop)` of the uniform flat modes (`Pianoid.flat_tier.flat_range`: `flat_tier_num_shaped`, `+ flat_tier_num_flat`) or `null` for a legacy preset (`{error}` if unreadable). The frontend's mode-column matrix editors (Feed-in, Feedback, Sound Channels strings axis) read it after a load/switch to write ONE value to all flat columns of an edited row; the backend write path enforces the same rule (`StringMap.update_deck*` → `flat_tier.sync_flat_edit`, see Basic OVERVIEW *Flat tier*).
- `stored_feedback_coeff` (added dev-fbsl, 2026-06-05): the active preset's PER-PRESET feedback baseline (`pianoid.mp.deck_feedback_coefficient`; default `1.0`). The frontend reads this after a preset load/switch to seed the stored layer of the two-layer feedback slider (the slider's off-center env multiplier is applied on top). See `POST /set_runtime_parameters` (`feedback_coeff` / `store_feedback_coeff`) and DATA_FLOWS §2.6.

`audio_driver_fallback` (added dev-asioload, 2026-06-02): `null` when no fallback
info is available (engine not loaded, or a build predating the feature). Otherwise a
dict describing the ASIO→SDL3 runtime fallback — `occurred` is `true` only when the
requested ASIO driver failed to initialize and the engine fell back to SDL3 (so the
user still has audio instead of `audio_driver_active: false`). `requested`/`active`
are driver names (`SDL2`/`SDL3`/`ASIO`/`ASIO_CALLBACK`); `message` is the short
user-facing warning and `reason` the underlying engine detail. **`skipped`** (dev-gh8, when
`occurred`): why EACH installed ASIO driver was skipped by the last open, e.g.
`'UMC1820' skipped: 8 outputs < 10 needed (engine channels / output map)` (also: not loadable,
`ASIOInit failed (…)`, no legal buffer size, cannot run at 48 kHz, `ASIOCreateBuffers` / `ASIOStart`
failed; `no ASIO driver is installed`); `message` appends them, so the UI audio chip shows the reason
(before dev-gh8 it was only in the backend log and everything read "no working ASIO device found"). The frontend lights a
"ASIO unavailable — using SDL3" warning on `occurred: true`. The same dict is pushed
on the WebSocket `lifecycle` event (`audio_driver_fallback` key) so the UI reacts
without polling. Engine-side mechanics: see
[AUDIO_DRIVERS.md — ASIO → SDL3 Runtime Fallback](../pianoid-cuda/AUDIO_DRIVERS.md#asio--sdl3-runtime-fallback).

**Amplitude crash-guard telemetry (dev-538e).** When a preset is loaded, `/health` also surfaces:

- `gate_trip_count` (int): cumulative number of synthesis cycles in which the amplitude/NaN crash-guard tripped (its self-heal path fired) since backend start / last `resetGateTripStats`. `0` at boot. Drives the toolbar "gate fired" indicator. Read from a device counter (`getGateTripStats`) with one cheap 2-int D2H copy per poll. Counts BOTH the amplitude-branch trip (`|displacement| > amplitude_limit`) and the unconditional `isnan` trip (in practice a geometric runaway is dominated by the amplitude branch).
- `last_gate_trip` (int): the synthesis-cycle index of the most recent trip, or `-1` if `gate_trip_count == 0`.
- `cooperative_launch` (top-level, added dev-1cda 2026-10-09; present even when no preset is loaded): the `addKernel` cooperative co-residency report — `{checked, ok, kernel, phase, grid_blocks, block_threads, num_regs, static_smem, max_threads_per_block, blocks_per_sm, device_sms, num_sms, capacity, message}` from `<module>.getCoopOccupancyReport()`. `phase` = `init` (pre-flight at `devMemoryInit`), `online` (re-check after the audio driver starts) or `launch` (the cooperative launch itself failed). `ok=false` ⇒ the grid cannot co-reside: an `init` shortage fails the load (`/load_preset` 500 `coop_launch_shortage`; with no engine left, this field keeps that failure — `{checked, ok:false, kernel, phase:"init", message}` — until the next successful load); an `online`/`launch` failure stops the realtime thread and also sets `exception` (status `crashed`). `null` = never checked (no load yet). See [SYNTHESIS_ENGINE → Register budget](../pianoid-cuda/SYNTHESIS_ENGINE.md#register-budget--cooperative-co-residency-pre-flight-dev-1cda-2026-10-09).
- `clipping` (bool): **latched** — `true` if any output channel's post-volume peak reached/exceeded INT32 full-scale (`2147483647`, the driver's hard-clip rail) since the last `/clear_limiting` or preset load. Survives the slow poll (clip-hold). Drives the toolbar clipping indicator.
- `clipping_now` (bool): **current** — a channel's current peak (below) `>=` full-scale.
- `peak_level` (float): the latched peak output magnitude as a fraction of full-scale (`>= 1.0` ⇔ clipping).
- `peak_level_now` (float, dev-f8f9): the current peak as a fraction of full-scale.
- All of them are also inside the `limiter` sub-object, with per-channel detail.

**Current vs latched (dev-f8f9, 2026-10-18).** The kernel keeps ONE per-channel peak-hold buffer (`dev_limiter_peak`, cleared only by `resetLimiterPeaks`). The backend (`limiter_telemetry.py`) reads AND resets it on every telemetry read (`/health`, the `param_ack` limiting ride), so the buffer holds the peak since the previous read:

| View | Fields | Meaning |
|---|---|---|
| current | `clipping_now`, `peak_level_now`, `limiter.active`, `limiter.clipping_now`, `limiter.peak_level_now`, per channel `pre_limit_peak` / `active` / `gain_reduction_db` | the peak since the previous read, decaying with `limiter.current_half_life_s` (0.5 s) across reads: about 0 within a second or two of silence |
| latched | `clipping`, `peak_level`, `limiting`, `limiting_info`, `limiter.latched_active`, `limiter.latched_max_gain_reduction_db`, per channel `latched_peak` | the max since `/clear_limiting` or the preset load |

Only **live, audible** output counts: the realtime thread runs and no transient override is in progress (`engine_busy` below). Offline / calibration renders write the same kernel buffer but never reach the driver; their peaks are dropped (also when live playback restarts after a render). A cycle written between the read and the reset is lost; a clip lasts many cycles. Before dev-f8f9 every "current" field was derived from the held buffer, so after one clip `clipping_now` stayed `true` and `pre_limit_peak == latched_peak` until a clear (bug report 2026-10-18T10-23-10), and the latch also held offline-render peaks.

**`engine_busy` (dev-f8f9)** — `{active, reason, since, last}`: the engine is overridden on purpose, so a stopped realtime thread or a slow backend is expected. `active` + `reason` = a transient route in progress (offline chart render `get_chart_test`, `/start_test`, `/audio/session`, `/synthesis_measure`; the same window as the WS `engine_busy` start/end events) or a calibration (`reason: "calibration"`, synthesis paused by `enter_calibration_mode`); `since` = its start. `last` = the latest finished transient `{reason, started_at, ended_at}`. Times are wall-clock ms, like `timestamp`. The frontend auto-reporter uses it to tell a render / calibration pause from a fault ([BUG_REPORT_TOOL](../pianoid-tunner/BUG_REPORT_TOOL.md)).

**`backend_thread_running`** is owned by the realtime managing thread (`long_running_procedure`, started only by `_spawn_realtime_thread`). It is `false` while a render or a calibration has the engine stopped. Since dev-f8f9 `exit_calibration_mode` restarts live playback through the same owner (`pianoid._restart_realtime_thread`), so the flag (and the preset's MIDI listener) come back after a calibration; before, they stayed off until the next render or preset load.

`GET /get_runtime_parameters` mirrors the runtime state and, on a dev-538e binary, adds
`amplitude_limit` (float) and `amplitude_gate_enabled` (bool) alongside `volume_level` / `volume_center` /
`volume_range` / `deck_feedback_coefficient` (guarded getattr — older binaries omit them).
`volume_center` is in the same **bare** units `POST /set_runtime_parameters` accepts (engine value ÷ active
`output_scale`), so a GET value can be SET back unchanged (dev-0da4; before, GET returned the engine product and
re-SETting it multiplied by `output_scale` again — 2.8e16 → 2.26e32). `effective_volume_center` is the raw engine
value and `output_scale` the active preset's scale (`effective_volume_center = volume_center × output_scale`).

Response `500` if health check itself throws.

---

### `GET /get_settings`

Returns default UI boot settings. Does not require a loaded preset.

Response `200`:
```json
{
  "path": "",
  "volume": "",
  "sample_rate": "",
  "string_iterations": 6,
  "use_simulation": 0,
  "debug_mode": 0,
  "listen_to_midi": 0
}
```

---

### `POST /load_preset`

Initializes the engine from a preset file (Apply). Optionally starts playback immediately.

**HOT vs STRUCTURAL re-init (Cluster C, dev-applyc).** When a live engine is already loaded, the route DIFFS the request against the signature of what's currently running and routes by what changed:

- **STRUCTURAL change** (preset name/path, `array_size`, `string_iterations`, `cycle_iterations`, `sample_rate`, `debug_mode`, `listen_to_modes`, `sound_derivative_order`, `audio_driver_type`, `audio_buffer_size`, `audio_on`) — or no live engine — → **full reload**: destroy the instance + re-initialize (re-allocates GPU buffers, re-opens the audio driver). Response `reinit: "full"`. These params are baked into the C++ constructor / `InitializationParameters` at init and have no runtime setter (`audio_driver_type`/`audio_buffer_size` open the driver in the constructor; there is **no driver-only reopen path**, so a driver/buffer change requires a full reload). **`array_size` (Block Size) is full-reload on purpose:** an in-place re-init at a new `array_size` renders SILENT because the StringMap rebuild drops the per-pitch sound-channel gains — a **Python** bug (not C++, whatever the `preset_reinit.py` / `pianoid.py` comments say); the fix is on PianoidCore `feature/dev-applyc-arraysize` (acb103d), DEFERRED by user decision 2026-10-28 ([WORK_IN_PROGRESS](../../development/WORK_IN_PROGRESS.md#deferred-block-size-array_size-in-place-re-init-silences-output-user-decision-2026-10-28)). Cost of the full reload: unsaved edits and the editor undo history are lost.
- **HOT-only change** (`volume` / `max_volume` / `feedback` / `feedback_coeff`) → **soft re-init**, **keeping the engine, the audio driver, and all loaded state** (no `devMemoryInit`, no `StringMap` rebuild). `feedback` / `feedback_coeff` go through the `/set_runtime_parameters` path; `volume` / `max_volume` are the **level anchor** (below) and are re-seeded in place **only if they differ from the live load** — an identical re-load writes nothing (`applied: {}`). Response `reinit: "hot"`. The frontend (`usePreset.loadPreset`) mirrors this by **suppressing its `presetVersion` bump + editor re-fetch** on `reinit: "hot"`, so the user's edited (unsaved) values are preserved across Apply.

**Level anchor vs slider level (dev-2fbf).** The load body's `volume` is the **preset (init) volume** — NOT the slider. It sets the level-64 anchor: bare `volume_center = exp((volume-100)/8)` (`1.0` at the default `100`) and `max_volume = volume_center^(127/64)`; an explicit `max_volume` wins (bare center `max_volume^(64/127)`). The **slider level** (`volume_level`, the `volume` of `/set_runtime_parameters` — same name, different thing) is session state owned by `/set_runtime_parameters`: **no load kind changes it** — hot and structural-inplace keep it, a full reload carries it over from the destroyed engine (a first load starts at 64), a library switch keeps it. Cold and hot agree: the same body gives the same anchor and level either way (measured p60 v127: full reload at volume 92 / slider 80 = hot re-load at volume 92 = −5.606 dBFS). The frontend mirrors the engine's level after every load (`GET /get_runtime_parameters` `volume_level` → slider). Before dev-2fbf the hot path forwarded the body's `volume` (100) to the slider level → an identical re-load (e.g. the UI autoload after a page reload) jumped the slider to 100, p60 +11.43 dB.

The classification logic is the pure, CUDA-free `pianoid_middleware/preset_reinit.py` (`classify_reinit`); the route diffs against a signature stashed on the pianoid object at each full load (`backendServer.py:load_preset_route`). Pre-Cluster-C behaviour (always full) is preserved for any caller whose response omits `reinit`.

**Omitted load settings keep the live values (dev-0a88).** Every load setting a request OMITS is
filled from the live engine's signature (the settings of the last full load, kept current by
in-place re-inits) BEFORE the hot / structural classification — the same "omitted = keep" rule
the classifier already applied, now also on the full path: `{"path": "presets/X.json"}` alone
reloads X with the user's current `sample_rate`, `string_iterations`, `sound_derivative_order`,
`array_size`, `listen_to_modes`, driver, buffer, `volume` anchor, `audio_on`,
`start_right_away`, `listen_to_midi` (the path and, since dev-392a, `midi_port` are never inherited; a legacy alias
such as `user_1` counts as given). Every success response lists them as
`inherited_load_params` (`{}` when nothing was inherited), and `load_param_warnings` now also
covers inherited values. With no engine loaded nothing is inherited and the four keys below are
still required (400 `invalid_preset_request`). Before dev-0a88 an assistant "load X, keep my
settings" failed on the four keys, and an omitted `listen_to_modes` / `sound_derivative_order` /
`array_size` on a full reload silently fell back to the route defaults (`1` / `1` / `384`).
Owner: `pianoid_middleware/load_settings.py` (`inherit_missing`); tests
`tests/unit/test_load_settings.py`.

Default preset: `presets/BaselinePreset1.json`

Request body (default initialization settings):
```json
{
  "path": "presets/BaselinePreset1.json",
  "listen_to_midi": 0,
  "midi_port": 0,
  "use_simulation": 0,
  "debug_mode": 0,
  "audio_driver_type": 4,
  "cycle_iterations": 64,
  "audio_buffer_size": 4,
  "array_size": 384,
  "sample_rate": 48,
  "string_iterations": 4,
  "volume": 120,
  "audio_on": 1,
  "start_right_away": 1,
  "listen_to_modes": 1,
  "use_cuda": 1
}
```

Parameter details:
- `audio_driver_type`: `0`=default (SDL3, hardware-free), `1`=ASIO, `2`=SDL (auto-detect SDL3 if available, else SDL2), `3`=SDL3, `4`=ASIO_CALLBACK

  Type `0` is pinned to SDL3 with `circular_buffer_chunks=16` — same as type `3`. Historically `0` was a "compile-time default" sentinel that resolved to whichever driver was prioritised in `ACTIVE_AUDIO_DRIVER` (ASIO when both ASIO and SDL3 are compiled in), but left the buffer depth at the ASIO default (`4`). On Windows builds compiled with both drivers this caused SDL3 driver underruns on the second in-place `/load_preset` reload — engine entered `audio_driver_active=false, exception=true` state. Fixed in dev-f99c (2026-05-01); see `pack_initialization_params_for_cuda` in `pianoid_middleware/pianoid.py`.

**Audio driver selection rule:** Prefer ASIO Callback (`4`) when an ASIO device is available — it provides the lowest latency. If ASIO is not available (no ASIO driver installed, or running without a dedicated audio interface), use SDL (`2`) as fallback. SDL works on all systems without special drivers. `0` is the safe default for tests / headless / "no specific audio hardware" callers — equivalent to type `3`.
- `cycle_iterations`: samples per cycle; must match audio buffer size, minimum 16, default 64
- `audio_buffer_size`: sizes the audio ring **memory** only (`max(128 × value, 512)` chunk slots). It does
  **not** change latency or stability — before dev-gh8 this line said "2 = low latency, 4 = balanced,
  8 = high stability", but the fill depth was hard-coded (ASIO 8, SDL3 16). Use `audio_ring_depth`.
- `audio_ring_depth` (optional, dev-gh8): the **Latency ↔ Stability** setting — ring fill depth in chunks
  of 64 frames, `0` = auto, integer `0..128` (rule `load_settings.audio_ring_depth` → `400
  parameter_out_of_range`). Per machine, persisted; omitted = keep the saved value; applied live (no
  reload). See [Audio ring depth](#audio-ring-depth-latency-vs-stability).
- `array_size`: spatial discretization points per string block; `384` (default) or `512`. Clamped to 384–512. When the requested value differs from the preset's native `array_size`, string geometry (`main` and `tail`) is scaled proportionally
- `sample_rate`: Hz; if < 1000 is multiplied by 1000
- `volume`: the **preset (init) volume** — the level anchor, default `100` (bare center `1.0`); see *Level anchor vs slider level* above. Not the slider level.
- `max_volume`: float, explicit anchor ceiling (takes precedence over `volume`; bare center `max_volume^(64/127)`)
- `start_right_away`: **binary** — `1`=start realtime playback in a background thread; `0` (or any non-`1`)=initialize only, do not start (engine is loaded and ready; playback is started later). The frontend only ever sends `0` or `1`. (The former `2`=start inline [deprecated] and `3`=init only [duplicate of `0`] values were removed in dev-5c3b, 2026-05-30 — the `2` branch had no caller and `3` was byte-identical to `0`.)
- `listen_to_modes`: `0`=sound channels carry string bridge displacement, `1`=sound channels carry mode forces (default `1`)
- `use_simulation`: `0`=normal operation (default, the only supported value); `1`=routes to `pianoid_cuda_placeholder.py`, a vestigial pre-library-API stub that has not been kept in sync with the live `pianoidCuda` API. **`use_simulation=1` is rejected with HTTP `400 FeatureNotSupported`** — the route handler short-circuits before destroying the engine. Fixed in dev-b001 (2026-05-01); pre-fix the request returned HTTP 500 `TypeError: Pianoid.__init__() missing 1 required positional argument: 'strings_in_pitches'` AND destroyed the live engine. See `backendServer.py:load_preset_route` and the deferred WIP follow-up "use_simulation/use_placeholder placeholder is vestigial" for the resurrection or retirement decision.
- `listen_to_midi`: `0`=do not start the unified MIDI listener thread; `1`=start the unified `MIDI_listener_unified` thread that routes inbound rtmidi messages through `Pianoid.schedule_event(...)` for cycle-aligned dispatch (decision A1 — listener defaults to rtmidi port `0`; see `GET /midi/ports`).

    **Default since W3 Phase 2:** the frontend `useSettings.js` ships with `listen_to_midi: 1` so the listener starts with the engine. Existing users with `listen_to_midi: 0` saved in localStorage keep their preference; pre-feature users (no key at all) inherit the new default.

    **Sysadmin / test-harness override:** the backend honours the `PIANOID_LISTEN_TO_MIDI` environment variable. When set to `"0"` or `"1"`, the value overrides whatever the request body sent (read per-request inside `/load_preset` so it applies to every preset load in the session). Unset / any other value → request body wins. Use this to pin listener state regardless of which UI the user runs (e.g. headless CI, mic-only calibration runs).

    **Runtime control:** after the engine is up, callers can hot-toggle without re-issuing `/load_preset` via `POST /midi/start` and `POST /midi/stop` (W3 Phase 2). Both are idempotent.
- `midi_port` (optional): rtmidi input-port index to FORCE for this load when `listen_to_midi=1` (not persisted, not inherited by the next load). Omitted (what the Tunner sends) = the user's saved input port, else auto-detect ([MIDI_SYSTEM → Input port](MIDI_SYSTEM.md#input-port-saved-port-and-auto-detect-dev-392a)). Before dev-392a an omitted `midi_port` meant `0`, so every load put the listener back on port 0. Use `GET /midi/ports` to enumerate ports and `POST /midi/select_port` to change ports in place.

Response `200` (full reload — structural change or no live engine):
```json
{"message": "Preset loaded successfully", "reinit": "full"}
```

**Load-param warnings (dev-17fd).** Every success response (full / hot / structural-inplace)
also carries `load_param_warnings`: `[{param, required, requested}]` for each load parameter the
preset DECLARES (`fpga_conversion.load_params`, or a top-level `required_load_params`) that the
request contradicts (`array_size`, `string_iterations`, `listen_to_modes`, `sound_derivative_order`;
an omitted request key is not a mismatch). Non-blocking: the load proceeds (geometry is rescaled),
the backend logs a `WARNING: preset load params differ …` line and the FE shows a persistent
warning snackbar naming the required values (e.g. F15_Elyashev_array512: 512 / 16 / 0 / 1).
`sample_rate` is compared in Hz (dev-12a5): the request's kHz value (`48`, scaled ×1000 by the
route) matches a declared `48000` — before the fix every correct F15 load warned "48 vs 48000".
The declaration survives `/save_preset` + promote (carried as entry `extras`, dev-12a5).

Response `400` (full reload with an unusable request — dev-12a5 fail-fast, checked BEFORE the
live engine is destroyed): `{"error": "InvalidPresetRequest", "code": "invalid_preset_request",
"message": "Preset file not found: presets/X (working 1)"}` (also: not readable JSON / not a
preset / missing `sample_rate`, `string_iterations`, `audio_on`, `start_right_away`). The running
engine and its unsaved edits are untouched. Before dev-12a5 such a request destroyed the engine
first and then returned 500 (FileNotFoundError / KeyError) → `No preset loaded`.

**Output map vs channel count (dev-16af).** Before ANY reinit kind, the backend's
`PIANOID_AUDIO_OUTPUT_MAP` is checked against the preset's channel count (`mode_sound_channels.num_channels`,
legacy 4) and the request's driver ([AUDIO_DRIVERS → output map](../pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver)).
Response `409` when it cannot apply — a map SHORTER than the channel count, or a map with a driver other than
`4` (ASIO callback): `{"error": "OutputMapMismatch", "code": "output_map_mismatch", "message":
"PIANOID_AUDIO_OUTPUT_MAP has 4 entries for 7 channels (...) - nothing was torn down: the loaded engine keeps
running."}`. A LONGER map loads on its first N entries; every success response carries `output_map_warning`
(`null`, or `"PIANOID_AUDIO_OUTPUT_MAP has 7 entries for 4 channels: using the first 4 (8,9,2,3)"`, also logged).
Before dev-16af the map raised inside `initialize()` after `destroyPianoid()` → no engine (incident 2026-10-20:
a stale tab re-applied a 4-channel preset under the 7-entry rig map).

Response `200` (hot re-init — only runtime params changed; engine + UI state kept):
```json
{"message": "Preset hot-reloaded (runtime params only)", "reinit": "hot", "applied": {"volume_center": 0.3679}}
```
`applied` lists what was written: `{}` for an identical re-load; `volume_center` (bare) when the level anchor changed (here `volume: 92`); `feedback` / `feedback_coeff` when sent.

Response `400` (hot apply with an invalid runtime value): `{"error": "HotApplyFailed", "message": "..."}`.

Response `400` (when `use_simulation=1`):
```json
{
  "error": "FeatureNotSupported",
  "message": "use_simulation=1 is not currently supported. The placeholder module is out of sync with the live library-API and would crash the engine. Pass use_simulation=0 (the default)."
}
```

Response `500` (cooperative co-residency shortage, added dev-1cda 2026-10-09): the engine's init
pre-flight found that the `addKernel` grid (`num_strings/4` blocks of `array_size` threads) cannot
be co-resident on this GPU — `{"error": "CoopLaunchShortage", "code": "coop_launch_shortage",
"message": "COOPERATIVE LAUNCH SHORTAGE (addKernel, phase=init): grid=58 blocks > capacity=57 (…)"}`.
Raised before any GPU allocation; the previous engine was already destroyed (full-load path), so
`/health` reports `pianoid_loaded:false` + `cooperative_launch.ok:false`. A follow-up load with a
feasible configuration succeeds in the same process. (Before dev-1cda the shortage surfaced only
as a first-cycle `cudaErrorCooperativeLaunchTooLarge`, and `pianoid.py` swallowed init
`RuntimeError`s so the load answered 200.)

Response `503` (no-CUDA limited mode, added dev-cudaguard 2026-06-10):
```json
{
  "error": "GpuUnavailable",
  "code": "gpu_unavailable",
  "gpu_available": false,
  "message": "No CUDA device available - GPU presets are disabled (limited mode). The Modal Adapter still works on CPU. Run tools/cuda_diagnostic.ps1 to diagnose the GPU/CUDA issue. (CPU synthesis is a deferred future feature.)"
}
```

The GPU-availability gate is checked **at the top of the route, before the existing engine is
destroyed** — so a no-CUDA load returns `503` cleanly and the running engine (if any) is NOT torn
down (it previously crashed with HTTP `500` after `destroyPianoid()`, the "destroy-then-crash" bug).
The same `gpu_available` flag is exposed on `GET /health` so the frontend disables APPLY pre-load.
Real CPU synthesis (PianoidBasic) is a deferred "cpu-sim" path that would be allowed through this
gate later — `docs/proposals/no-cuda-cpu-synthesis-2026-06-10.md`.

---

### `GET /load_settings`

(dev-0a88) The settings the running engine was loaded with, in `/load_preset` request form, what
the loaded preset declares (`fpga_conversion.load_params` / `required_load_params`, see
*Load-param warnings*) and the mismatches. Read-only (registry `preset.load_settings`). Response
`200`:

```json
{"loaded": true, "path": "presets/F15_measured_plywood_2026-10-15.json",
 "settings": {"array_size": 512, "string_iterations": 8, "cycle_iterations": 64, "sample_rate": 48000,
              "listen_to_modes": 0, "sound_derivative_order": 2, "debug_mode": 0, "audio_on": 1,
              "audio_driver_type": 4, "audio_buffer_size": 4, "volume": 127, "start_right_away": 1,
              "listen_to_midi": 1, "midi_port": 0},
 "declared": {"listen_to_modes": 0, "sound_derivative_order": 1, "array_size": 512,
              "string_iteration": 16, "sample_rate": 48000, "samples_in_cycle": 64},
 "mismatches": [{"param": "string_iterations", "required": 16, "requested": 8},
                {"param": "sound_derivative_order", "required": 1, "requested": 2}]}
```

`sample_rate` is in Hz; `volume` is the load level anchor (not the slider). `path` is the last
FULL load's file (a library switch does not change it). No engine: `{"loaded": false, "path": null,
"settings": {}, "declared": {}, "mismatches": []}`.

### System state reads (assistant v2 P1) {#system-state-reads-assistant-v2-p1}

(dev-fcef) Read-only routes behind the assistant's state commands (owner
`pianoid_middleware/system_routes.py` over the pure helpers in `system_state.py`, tests
`tests/unit/test_system_state.py`; `write_routes` class `read_only`). Design: assistant v2 proposal §3.
Registry: `system.health` (= `GET /health`), `system.environment`, `system.snapshot`, `audio.devices`
(= `GET /audio/devices`), `midi.ports` (= `GET /midi/ports`), `midi.broadcast_state` (= `GET /midi/broadcast`),
`preset.summary`, `preset.files`, `param.inventory`.

**Data rule (D4 / V13).** Everything here may reach the model, so the environment variables are an
**allow-list** (`system_state.ENV_ALLOW`): never `ANTHROPIC_*`, tokens, `PATH` or the user profile. A
path-valued variable is shown only when it points inside the Core or Install checkout, else as
`"<set: outside the repos>"`. Preset files are listed only under the allow-listed root, never a
caller-given folder.

### `GET /system/environment`

`{gpu: {gpus: [{name, memory_total, driver_version}], driver_cuda_version}, engine_build: {variant
release|debug, loaded, module_file, build_time (UTC, the .pyd mtime), packages: {Pianoid, pianoidCuda,
pianoidCuda_debug}}, repos: {PianoidInstall|PianoidCore|PianoidBasic|PianoidTunner: {path, branch, sha,
dirty} | {path, error}}, python, os, process: {pid, backend_port}, output_map: {raw, map, identity,
meaning}, env: {<allow-listed PIANOID_* that are set>}, fingerprint: {gpu, build, repos: {core:
"dev@963b6ce*", ...} ('*' = dirty), output_map}}`. The GPU block is read once per process
(`nvidia-smi`); the repo state is read per call (`git rev-parse` / `status --untracked-files=no`, 3 s
timeout each). Install = two levels above the command registry dir (`$PIANOID_COMMANDS_DIR`); Basic and
Tunner = the folders inside it. `output_map` = `PIANOID_AUDIO_OUTPUT_MAP`: engine channel k plays on
ASIO device output `map[k]`, unset = identity ([AUDIO_DRIVERS](../pianoid-cuda/AUDIO_DRIVERS.md)).

### `GET /system/snapshot`

`{timestamp, health (GET /health), load_settings (GET /load_settings), environment (above),
active_preset (GET /preset/summary of the active entry, null without an engine)}`. The assistant's
per-turn context carries only the environment `fingerprint` (so it notices an engine / build change
between turns); this read is the first call of a "full state" question.

### Environment settings {#environment-settings}

(dev-aenv1) `GET` / `POST /settings/env`: the **governed** way to read and set the backend's environment
variables (owner `pianoid_middleware/runtime_env.py`, routes in `system_routes.py`, `write_routes` class
`read_only` / `action`, tests `tests/unit/test_runtime_env.py`). Registry: `env.get`, `env.set` (assistant rule
`env.set`: Ask by default, risky = a warning line, can be set to Always allow; not part of the Autonomous preset;
undoable by the pane's Undo / Undo turn, which sets the `previous` value back).

| variable | target | applies | value | meaning |
|---|---|---|---|---|
| `PIANOID_AUDIO_OUTPUT_MAP` | backend | next load | distinct outputs `0..31`, comma-separated | engine channel k -> ASIO output `map[k]` ([AUDIO_DRIVERS](../pianoid-cuda/AUDIO_DRIVERS.md#asioaudiodriver)) |
| `PIANOID_ASIO_BUFFER_SIZE` | backend | next load | frames, multiple of 64, <= 8192 | requested ASIO host buffer (callback driver) |
| `PIANOID_LISTEN_TO_MIDI` | backend | next load | `"0"` / `"1"` | forces the MIDI listener on every `/load_preset` ([MIDI_SYSTEM](MIDI_SYSTEM.md)) |

- **Order:** setting (the gitignored local settings file `<PianoidInstall>/pianoid_local_settings.json`, key
  `env`; `$PIANOID_LOCAL_SETTINGS` in tests) > the environment the backend inherited from the launcher > unset.
  The backend applies the persisted values at boot (`init_system_routes`), so they survive restarts.
- **Applies `next_load`:** `POST` writes the value into the backend process at once (`os.environ`; the
  engine's C++ `getenv` sees it too: shared UCRT, measured); the readers use it on the **next `/load_preset`**
  (a reload of the same preset is enough). The running engine is unchanged until then. **`restart`** (no
  variable yet): saved only, `restart_required: true`; nothing restarts by itself (launcher commands).
- **Allow-list only:** an unknown name -> `400 {error: "unknown_variable", allowed}` (the backend environment
  also steers DLL search, CUDA and Python, so there is no "any variable" mode; a new variable = one row in
  `runtime_env.VARS` + the `env.set` name enum, kept equal by a test). Secret-looking names (KEY / TOKEN /
  SECRET / PASSWORD / CREDENTIAL / AUTH) are refused and their values never returned (`<masked>`).
- `GET` -> `{variables: [{name, description, doc, target, applies, value_format, value, source
  (setting|env|unset), setting, inherited, restart_pending}], settings_file}`.
- `POST {name, value}` (`value` null or `""` clears the setting: back to the inherited value) -> the variable's
  state + `previous` (the setting before), `restart_required`, `effect`; invalid value ->
  `400 {error: "invalid_value", message}`. Every change is printed to the backend log (`[runtime_env]`) and,
  for the assistant, recorded in its audit log.

**Migration (2026-10-28):** the rig's output map `8,9,2,3,4,5,6` (E1/E2 rewired to Out 9/10, then
process-scoped in the backend's environment) is saved once as the setting
(`env.set PIANOID_AUDIO_OUTPUT_MAP "8,9,2,3,4,5,6"`) when this lands; from then on no environment variable is
needed for it.

### `GET /preset/files`

`{roots: {presets: "presets"}, count, truncated, files: [{root, file, load_path, size_kb, modified,
header}]}`: every `*.json` under `pianoid_middleware/presets` (two folder levels, at most 200).
`load_path` (`presets/<file>`) is what `POST /load_preset` and `POST /preset/load` take. `header` =
`{num_modes, num_strings, num_channels, listen_to_modes, sr, array_size, string_iteration,
sound_derivative_order, output_scale, output_scale_calibrated, output_scale_target_dbfs (those present),
piano_pitches: [first, last, count], declared_load_params, provenance?: {fpga_conversion: {converter,
options}, measured_modes_build: {builder}}}`, or `{error}` for a file that is not a preset. Headers are
cached by mtime + size (the first call parses every file). `PresetsFromFpga/` holds raw FPGA tables, not
loadable presets, and is not a root.

### `GET /preset/summary`

`?entry=<library name>` (default the active entry). `{name, kind, source, path, source_path, active,
editable, model_parameters (the in-memory entry: the header keys above), undo_depth (groups in the
backend undo history of this entry), file (the header of source_path), load? (active entry only: the
GET /load_settings body)}`. `400` no engine; `404 {error: unknown_entry, entries}`.

### `GET /param/inventory`

The parameter inventory, PianoidInstall `schemas/params/*.json` (`$PIANOID_PARAMS_DIR`, else `params`
next to the command registry dir): per domain `{domain, title, read, write, key_space, shape,
stored_vs_effective, doc, fields: [{name, units, range, class, meaning, doc}]}`. No query = the overview
`{unknown_policy, doc_conflicts, domains: [{domain, title, group, key_space, write, fields: [names]}]}`;
`?domain=<name>` = one domain in full; `404 {error: unknown_domain, domains}`. Every value comes from the
docs; **`UNKNOWN` = the docs do not state it** (measure before relying on it).

### `POST /save_preset`

Saves the ACTIVE library entry (its Python model + its non-model `extras` such as
`fpga_conversion` / `excitation_provenance`) to a file. `.json` is appended when missing.
Saving onto a loaded original's file refreshes that original in memory + its GPU slot
(same path as promote) — dev-12a5.

Request body:
```json
{"path": "presets/MySave.json"}
```

Response `200`:
```json
{"message": "Preset saved successfully", "path": "D:\...\presets\MySave.json",
 "refreshed_original": null, "presets": [{"name": "...", "kind": "...", "source": "...", "path": "...", "source_path": "..."}]}
```
`refreshed_original` = the library original re-synced to the written file (or `null`).

---

### `GET /reset`

Calls `pianoid.reset()` to reinitialize simulation state without reloading the preset.

Response `200`:
```json
{"message": "Reset successfull"}
```

---

### `POST /shutdown`

Graceful shutdown: destroys the pianoid instance (freeing GPU resources), stops the MIDI listener, then terminates the Flask process via `SIGTERM` after a short delay so the HTTP response can be sent.

Response `200`:
```json
{"message": "Shutting down"}
```

The process exits ~300 ms after responding. If cleanup raises an exception, the endpoint still proceeds with shutdown. Callers should follow up with a force-kill (`taskkill /T /F`) if the process does not exit within a few seconds.

---

### `POST /audio/reopen`

(dev-19be) Queue a close + re-open of the **requested** audio driver; the synthesis loop
performs it at its next iteration (only while playback runs), falling back to SDL3 if ASIO
cannot open. Use after reconnecting an audio interface (the engine sits in `fallback`).
Body (optional): `{"reason": "device reconnected"}`. Response `200`:
`{requested: true, loop_running, note, audio_health}`; `400` when no engine is loaded.

### `POST /debug/audio_fault`

(dev-19be, **test hook**) Simulate an audio-driver fault without unplugging hardware.
Body: `{"kind": "reset_request" | "resync_request" | "latencies_changed" | "stall" |
"device_loss" | "device_return", "duration_ms": 3000}`. The `*_request` kinds are delivered
through the real ASIO `asioMessage` handler (ignored by a non-ASIO driver, still counted);
`stall` makes the active driver's callback stop serving the ring for `duration_ms`;
`device_loss` replays the 2026-10-08 incident (callback stall + `kAsioResetRequest` + every
ASIO open fails until `device_return`). Response `200`
`{injected, result, audio_health}`; `400` for an unknown kind / bad `duration_ms` / no engine.

### Audio ring depth (latency vs stability) {#audio-ring-depth-latency-vs-stability}

(dev-gh8, PianoidCore #8) The synthesis thread hands the audio callback one 64-frame chunk per cycle
through a ring; its **fill depth** (chunks queued ahead of the device) is the latency the engine adds and
the cushion against a late synthesis cycle (an underrun = an audible click).

| | |
|---|---|
| Latency formula | **ring_ms = depth × 64 / sample_rate** (8 → 10.7 ms, 4 → 5.3 ms, 16 → 21.3 ms @ 48 kHz); estimate = ring_ms + the driver's output latency (ASIO-reported `output_latency`, else one host buffer) |
| Auto (`0`, default) | ASIO callback `max(8, 4 × blocks per host switch)` = 8 on a 64-frame host buffer (unchanged behaviour); SDL3 16 |
| Explicit `1..128` | the driver floors it: ASIO `max(depth, 2 × blocks per switch, 2)`, SDL3 `max(depth, 16)`; `applied` reports the result |
| Bounds | rule `load_settings.audio_ring_depth` (integer 0..128) — the same rule for `/load_preset` and this route ([parameter rule table](#parameter-rule-table)) |
| Persistence | per machine, local settings file key `audio_ring` (survives restarts; not per preset, not per client) |
| When it applies | **live** on the running driver (`Pianoid::setAudioRingDepth`, no reload, no audio restart); every later driver open / watchdog re-open / SDL3 fallback uses it |

`GET /audio/ring_depth` → `200 {requested, auto, max, applied, live, sample_rate, chunk_frames, ring_ms,
driver_latency_ms, driver_latency_source (asio_output_latency | host_buffer), estimate_ms, formula}`
(`live: false`, `applied: null` with no engine).
`POST /audio/ring_depth {"depth": 4}` → `200` = the GET body + `previous`, `effect` (`applied live` |
`saved; applies when the audio driver starts`); `400 parameter_out_of_range` outside the bound, `400
invalid_request` without `depth`. Broadcasts `session_changed {domain: audio_ring}`. Registry commands
`audio.ring_depth` / `audio.set_ring_depth`; Tunner: Settings → Audio "Latency ↔ Stability".
Measured on the UMC1820 rig: [AUDIO_DRIVERS → Ring depth measurements](../pianoid-cuda/AUDIO_DRIVERS.md#ring-depth-latency-vs-stability-dev-gh8).

### `GET /audio/devices`

(dev-1b6c) Snapshot of the ASIO host the engine has open (cached when the driver opened —
no ASIO call from the Flask thread). Response `200`:
`{asio: {open, driver, sample_rate, buffer_size, buffer_size_range [min, max, granularity],
input_latency, output_latency, reported_roundtrip, output_ready, supported_sample_rates,
inputs: [{index, name, type, type_name, supported}], outputs: [...], switch_count,
session_active, reset_requests, latency_changes, clock}, engine: {loaded, lifecycle_state,
calibrating, audio_driver_active, active_driver_type, active_driver, active_audio_driver_type}}`. With no engine loaded:
`{asio: {open: false}, engine: {loaded: false}, note}`. `501 no_session_api` when the
installed `pianoidCuda` predates the session API. Channel facts of the rig (UMC1820):
[AUDIO_DRIVERS.md — ASIO measurement session](../pianoid-cuda/AUDIO_DRIVERS.md#asio-measurement-session-dev-1b6c).

**`asio.clock`** (dev-431a, `asio_clock.py`): the measured bufferSwitch pace against the engine's
buffer — `{measured, buffer_size, buffer_size_in_driver_range, expected_switch_rate_hz (= sample_rate /
buffer_size), switch_rate_hz, switch_period_ms, frames_per_switch_measured, realtime_ratio, realtime}`
(the `switch_count` timed between counter edges over 0.25 s with `time.perf_counter`; `realtime` = within 15 %:
a wrong-pace host is off by an integer factor, while the old 15.6 ms `time.monotonic` + 5 % refused a healthy
UMC1820 at 0.965 … 1.07, dev-431a live). Since the dev-431a C++ fix the host creates its ASIO buffers at a
driver-legal **whole number of 64-frame engine blocks** (64 whenever the driver allows it; else the driver's
preferred size or the smallest legal multiple; `PIANOID_ASIO_BUFFER_SIZE` requests another legal multiple) and
runs the engine block callback N times per switch, so `buffer_size` here is that host buffer and a fixed-size
driver (field case: `buffer_size_range [1152, 1152]`, which before the fix switched every 24 ms while the host
counted 64 frames → `realtime_ratio` ≈ 0.33) runs in real time. The check stays as the guard against a driver
that still does not switch at `sample_rate / buffer_size`; remedy: set the driver's ASIO buffer to 64 samples
and reload the preset. `{measured: false}` on a binary without `switch_count`.
**Driver numbering:** `active_driver_type` is the engine's `AudioDriverType` enum (SDL2 0 · SDL3 1 · ASIO 2 ·
ASIO_CALLBACK 3); `active_audio_driver_type` is the SAME driver in the preset / `/load_preset`
`audio_driver_type` numbering (1 ASIO · 2 SDL · 3 SDL3 · 4 ASIO callback); `active_driver` is the name
(the `/health` fallback block uses the same names). So `3` here and "ASIO_CALLBACK (4)" elsewhere agree.

### `POST /audio/session`

(dev-1b6c) One sample-locked measurement on the engine's ASIO device: a preloaded signal
matrix is emitted on chosen **physical** outputs while chosen inputs are captured in the
**same** `bufferSwitch` (output frame *n* and input frame *n* share one callback → constant
offset, no jitter). **Synthesis is paused** for the session (`enter_calibration_mode(keep_audio
=True)`, device stays open — decision D6) and resumed afterwards; every output the session does
not drive is silenced. ASIO-only (409 when the engine is not on an ASIO driver). One session at
a time; the request holds the lifecycle gate's shared slot, so a `/load_preset` waits / 409s.

| Field | Meaning |
|---|---|
| `mode` | `play_record` (default) · `record` · `play` |
| `outputs` / `inputs` | lists of channel **indices** (0-based) or **names** (`"Out 1"`, `"OUT 01"`, `"In 8"`, `"ADAT 3"`; case/space/leading-zero-insensitive) |
| `signal` | `{"npy": "<path to float32 [frames, len(outputs)] .npy>"}` or `{"inline": [[...], ...]}` (1-D allowed for one output); peak must be ≤ 1.0 (full scale) — not for `record` |
| `seconds` | `record` length |
| `pre_roll_s` / `post_roll_s` | silence before / after the signal (defaults 0.1 / 0.5 s; post 0 for `play`) |
| `loopback` | `{"output": "Out 5", "input": "In 8", "marker_level": 0.5}` — emits a one-sample marker on the loopback output at signal frame 0 and reports its measured onset (the electrical round trip); the input is added to the capture |
| `compensate_latency` | `"none"` (default, raw) · `"reported"` (drop in+out reported latency) · `"loopback"` (drop the measured onset) · `true` (loopback if present else reported) · an integer frame count |
| `timeout_s` | default 1.5 × length + 3 s (length = pre-roll + signal + post-roll at the device rate); the HTTP client (`RemoteAudioIO`) waits 1.5 × 120 + 33 s, above the longest session's timeout |
| `out_dir`, `tag`, `return_data` | result folder (default `<measurements base>/audio_sessions/<session_id>/`, base = the [measurements folder](#measurements-folder)); free-text tag; include `data` inline when ≤ 200 k samples |

Session length ≤ 120 s. Response `200` (also written to `meta.json`; capture in `data.npy`,
float32 `[frames, len(inputs)]`, normalised to each channel's full scale):
`{session_id, tag, mode, status: "ok", driver, sample_rate, buffer_size, outputs[{index,name}],
inputs[...], signal_frames, pre_roll_frames, post_roll_frames, frames, frames_captured,
start_sample_position, switches, xruns, latency {input_frames, output_frames,
reported_roundtrip_frames}, loopback {detected, onset_frames, peak_frames, peak_level_dbfs,
measured_minus_reported_frames, output, input}, compensation {mode, shift_frames, note},
levels {<input name>: {rms_dbfs, peak_dbfs}}, synthesis {paused, resumed}, data_path,
data_shape, elapsed_s}`. Raw timeline: capture frame *n* = output frame *n* (pre-roll
included); the signal starts at `pre_roll_frames`.

Errors: `400` bad body / unknown or duplicate channel / signal shape, NaN or > 1.0 / too long;
`409` `asio_not_open` · `session_in_progress` · `engine_busy` (calibration running) ·
`asio_unavailable` · `asio_not_realtime` (dev-431a: checked before anything plays or synthesis pauses — the
driver does not switch at `sample_rate / buffer_size`, see `asio.clock` above; the body carries `clock` and
the message the numbers and the remedy); `501 no_session_api`; `502 session_aborted` (`timeout`, `reset_request` — a
driver `kAsioResetRequest`, which the dev-19be watchdog then services on resume — or `stalled`:
no callback for 0.5 s) with the partial result in `session` (data still written; the message carries the frames captured,
the elapsed time, switches × buffer size, xruns and the frames/s achieved vs the device rate), and
`502 loopback_not_detected` for `compensate_latency: "loopback"` without a marker onset.

### Rig measurement pipeline (assistant) {#rig-pipeline}

(dev-8a9e, `rig_pipeline_routes.py` + `modal_adapter/rig_pipeline/`) The board-measurement → preset pipeline as
fixed, typed steps for the assistant (registry `modal.rig_*`, `preset.create`; parameters, defaults and ranges =
the registry args in `schemas/commands/modal.json` / `preset.json`, the single source; the guide
[MODE_DISCOVERY_FOR_ASSISTANT → Rig commands](../../guides/MODE_DISCOVERY_FOR_ASSISTANT.md#rig-commands) lists them).
Each write route validates its body against its command schema (400 `invalid_args` with every violation), fills
the defaults and runs ONE step as a child process
`python -m pianoid_middleware.modal_adapter.rig_pipeline <step> --spec <file>` (cwd PianoidCore, no shell). The
response is `{started, step, dry_run, jobId}`; the `rig` job (`job.get`) carries progress and, at the end, the
step's result or its error. One rig job at a time (`409 rig_busy`). The ASIO steps call back
[`POST /audio/session`](#post-audiosession) on this backend (ASIO callback driver; synthesis pauses per session).

| Route | Command | Step |
|---|---|---|
| `POST /rig/capture` | `modal.rig_capture` (asks: its own rule) | a sweep (ESS / linear) per exciter × repeats on the chosen outputs, the chosen inputs recorded; level guard (redo a first repeat above `guard_dbfs` at `step_db` lower, abort above `stop_dbfs`); `dry_run` plans only |
| `POST /rig/sine` | `modal.rig_sine` (asks: its own rule) | a sine on chosen outputs (per-output level, fades), `duration_s` or `until_stopped` (chunks of `chunk_s`, ≤ `max_duration_s`), optional `record_inputs` (play + record); `sequence` = several tones in turn (per step `frequency_hz` / `outputs` / `duration_s`, `pause_s` silence between; ≤ 64 steps, ≤ 1800 s of tone) |
| `POST /rig/record` | `modal.rig_record` (asks: its own rule) | inputs only, `duration_s` ≤ 110 s, optional software `trigger`; result: per-channel `rms_dbfs` / `peak_dbfs` / `clipping` |
| `POST /rig/process` | `modal.rig_process` (asks: its own rule) | `step` = `frf` · `polymax` · `coefficients` · `build_preset` on a run (`area` `rig_runs` or the read-only `rig_checks`) |
| `POST /rig/preset_create` | `preset.create` (asks: its own rule) | a NEW preset with `num_strings` / `num_channels` / `array_size` (/ `num_modes`) from a base preset; refuses an existing name unless `overwrite` |
| `POST /rig/cancel` | `modal.rig_cancel` (also `job.cancel`) | terminates the step's process; a sweep / chunk already playing finishes |
| `GET /rig/runs[?run=&area=&limit=]` | `modal.rig_runs` | the runs (id, kind, steps done, size) or one run's config, step reports and files |
| `GET /rig/files?run=&area=&files=…` | `modal.rig_files` | absolute path + size of run files (the assistant's `export: true` copies them into an analysis artefact) |
| `GET /measurements/dir` | `modal.measurements_dir` | the measurements folder and where it comes from ([below](#measurements-folder)) |
| `POST /measurements/dir` | `modal.set_measurements_dir` (asks: its own rule) | moves the measurements folder (runtime setting) |

Run layout `<measurements>/rig_runs/<run_id>/` (`<measurements>` = the [measurements folder](#measurements-folder); run id `<yyyymmddThhmmss>-<label>`): `config.json` (spec, channel maps, levels, takes,
flags, status), `sessions/<exciter>_m<level>_r<k>/{data.npy (aligned capture, float32 [frames, inputs]),
signal.npy, meta.json}` (`silence/`, `chunk<NNN>/`, `record/` for the other kinds), then `frf/` (`frf.npz`: f, H
[repeats, F, inputs, exciters]; `coarse_frf.npz`: freqs, H3 = the repeat average; `report.json`), `polymax/`
(`report.json`, `modes.npz`, `stabilization.png`) and `coefficients/` (`measured_table.json` = the input of
`Pianoid.measured_mode_preset`, `report.json`). A step on a `rig_checks` capture writes its outputs to
`rig_runs/<run>/` (with `source.json`). Presets go to `pianoid_middleware/presets/<name>.json`.

#### Measurements folder {#measurements-folder}

(dev-3f58, `modal_adapter/measurements_location.py`) The ONE folder every rig step and read, the audio sessions
(`audio_sessions/`), the modal adapter's measurements (:5001) and the measurement CLIs (`swept_discovery`,
`appropriation`, `rig_checks`) use. Resolution, first set wins:

| # | Source (`source`) | Where |
|---|---|---|
| 1 | runtime setting (`setting`) | `measurements_dir` in the local settings file `<PianoidInstall>/pianoid_local_settings.json` (gitignored; `$PIANOID_LOCAL_SETTINGS` overrides the file path). Written by `POST /measurements/dir`; survives restarts |
| 2 | `$PIANOID_MEASUREMENTS_DIR` (`env`) | the environment of the backend / adapter |
| 3 | repo default (`default`) | `<PianoidInstall>/measurements` (resolved from the install location, never a drive path; gitignored) |

The settings file is read on every call, so :5000, :5001 and the rig-step child processes see a change at
once. Folders are created on demand by the writers.

- `GET /measurements/dir` (`read_only`) -> `{measurements_dir, source, exists, setting, env, default, settings_file}`.
- `POST /measurements/dir {"path": "<absolute folder>" | null}` (`action`) -> the same body. `path` must be
  absolute, a folder (or not exist yet) and writable: the folder is created and probed with a temp file, else
  `400 bad_request`; `null` / `""` clears the setting (back to the env var / default); `409 rig_busy` while a rig
  job runs. **Data is never moved:** runs in the old folder are simply no longer listed.

### `POST /pause_synthesis`

Pauses the synthesis cycle (transitions `PLAYBACK_ACTIVE` → `PAUSED`). GPU resources are retained — the engine stops producing audio but can resume instantly.

Response `200`:
```json
{"message": "Synthesis paused"}
```

---

### `POST /resume_synthesis`

Resumes synthesis after a pause (transitions `PAUSED` → `PLAYBACK_ACTIVE`).

Response `200`:
```json
{"message": "Synthesis resumed"}
```

---

### Exciter monitor (dev-8f54) {#exciter-monitor}

Current / board sensors on the ASIO inputs during normal playback, and a per-exciter current-limit safety
limiter: `exciter_monitor_routes.py` over `exciter_monitor.py` / `exciter_monitor_config.py`; engine stage
`ExciterMonitor.cpp` ([AUDIO_DRIVERS → Exciter monitor](../pianoid-cuda/AUDIO_DRIVERS.md#exciter-monitor-dev-8f54)).
Design: [controlled playback](../../proposals/controlled-playback-exciter-current-2026-10-20.md). Needs the ASIO
callback driver (`audio_driver_type 4`); stored per machine under `exciter_monitor` in
`pianoid_local_settings.json`. Assistant: `audio.exciters`, `audio.exciters_config` (asks: its own rule),
`audio.exciters_clear`.

#### `GET /audio/exciters`

`read_only` → `{config, telemetry}`. `telemetry` (also the socket event **`exciter_telemetry`**, at
`config.telemetry_hz` = 25 Hz while enabled and an ASIO device is open):

| Field | Meaning |
|---|---|
| `enabled`, `api`, `device_open`, `configured` | monitor on · an engine with the API is loaded · ASIO open · the engine runs the current config |
| `sample_rate`, `buffer_size`, `rate {frames_per_s, expected, ok}` | input frames metered per second over the window (≈ the sample rate during playback) |
| `inputs[]` | `{index, name ("In 1"), label, kind, unit ("FS" when uncalibrated), uncalibrated, full_scale, present, rms, peak, rms_fs, peak_fs, rms_dbfs, peak_dbfs, clipping, test_level}` |
| `exciters[]` | `{channel, name, present, output {peak_dbfs, rms_dbfs} (post-limiter), current {input, input_name, rms, peak, unit, full_scale, limit, target, uncalibrated} \| null, board {...} \| null, gain_db, min_gain_db, trim_db, limiting, at_floor, attacks (cumulative), latched {max_current_peak, min_gain_db, attacks}, warnings[]}` |
| `warnings[]` | `{code, exciter?, message}`: `sensor_silent` (plays, sense below `sensor_check.min_sense_dbfs` for `hold_s`), `map_suspect` (another current input carries it), `input_clipping` (≥ 0.99 FS), `limit_floor` (gain at the floor > 1 s), `uncalibrated`, `rate_low` (< 90 % of the sample rate) |

Values are `null` when nothing was metered (no device, disabled). The window is the time since the previous
sample (each sample resets the engine window).

#### `POST /audio/exciters/config`

`session` (`session_changed {domain: exciter_monitor}`). Body = a partial patch; the result is validated,
saved and pushed to the engine at once → `{status, config, telemetry}`; `400 invalid_config` (with the reason) /
`400 engine_refused`.

| Key | Patch rule · fields |
|---|---|
| `enabled`, `telemetry_hz` (1–60) | replace |
| `inputs` | merged by `index` (0–31): `{index, kind current\|board\|other, label, scale (units per full scale, > 0, null = uncalibrated), unit}` |
| `exciters` | merged by `channel` (engine channel 0–15): `{channel, name, sense_input, board_input (metered inputs or null), limit (block peak, sense unit, null = no limiter), target (RMS, closed loop), release_ms (10–10000)}` |
| `limiter` | `{floor_db (−60…0, −30), release_threshold (0.05–1, 0.9), holdoff_switches (null = one measured round trip + 1)}` |
| `closed_loop` | `{enabled (false), rate_db_per_s (1), max_cut_db (12), max_boost_db (0, ≤ 6)}` |
| `sensor_check` | `{output_dbfs (−50), min_sense_dbfs (−90), hold_s (0.4)}` |
| `{…, "remove": true}` / `replace: true` / `reset: true` | drop one list item · replace the lists · start from the default |

Example (E3 limited to 1.5 A peak with a 0.1 Ω sense into a 2 V full-scale input: `scale` = 20 A/FS):
`{"enabled": true, "inputs": [{"index": 2, "scale": 20}], "exciters": [{"channel": 2, "limit": 1.5}]}`.

#### `POST /audio/exciters/clear`

`session`: clears the latched values and puts every limiter gain back to its ceiling → `{status}`.

#### `POST /debug/exciter_test_level`

TEST HOOK (`session`): `{input, level_fs}` — physical input `input` reads at least a sine of peak `level_fs`
(0–4 FS, 0 = off) in the engine, so the limiter can be exercised without a sensor. `409` with no engine.

---

### Output routing (dev-rad1) {#output-routing-dev-rad1}

Where the synthesized sound goes, and how each soundboard mode reaches the speakers. Logic:
`output_routing.py` (session state + plan + rows), routes `output_routing_routes.py`. Design:
[mode-radiance-output-mode proposal (archived)](../../proposals/archive/mode-radiance-output-mode-2026-10-29.md).

| target | layout | engine channels |
|---|---|---|
| `board` (default) | — | the preset's exciter rows, unchanged (bit-identical to before dev-rad1); dedicated speaker channels silent |
| `speakers` | `mono` / `stereo` | the speaker channel(s) carry `y = D^k Σ_m g·r[m]·q_m`; every exciter channel silent |
| `dual` | `mono` / `stereo` | both at once; needs **dedicated** speaker channels |

* **Factors** `r[m]`: per-mode fields `radiance_mono`, `radiance_left`, `radiance_right` (linear gains `>= 0` (no cap; absolute factors are in engine row units),
  default 1; GET returns the EFFECTIVE sides, = mono until a pair is set, plus the STORED `radiance_stereo` (`[L, R]` or
  `null` = follows mono; hidden in the Modes panel), `POST /set_parameter/mode/<m>` like any mode
  field (undo, journal, `param.set`, rule table). Preset: `modes[m].radiance_mono` / `radiance_stereo: [L, R]`, written
  only when set. POST also accepts `radiance_stereo` (`[L, R]`, or `null` = clear the pair, back to following mono).
  Undo of an L / R edit restores the stored pair exactly, incl. "follows mono" (it snapshots `radiance_stereo`, the field
  L / R write; `parameter_manager.STORED_FIELD_OF`, dev-rad2).
  A radiance-only edit uploads no mode physics; the speaker rows re-upload when a speaker mix plays.
* **Rows** (host precompute, no kernel change): the speaker channel's deck row is `g·r[m]` (`basis: absolute`) or
  `g·r[m]·b[m]` (`basis: board_motion`, `b[m]` = RMS over the native exciter rows = the engine's mode motion at the
  exciter points). `g` makes the speaker channel's analytic energy (`Σ_m row[m]²·E_m`, `E_m` = the unit-force response
  energy at `sound_derivative_order`, DATA_FLOWS "Analytic audible weight") equal the mean exciter channel energy, then
  `trim_db` (default −3 dB headroom) applies. Flat-tier presets fold the uniform flat columns to one energy-weighted value.
* **Speaker channels.** *Dedicated*: `model_parameters.radiance.speaker_channels` = `[c]` or `[cL, cR]` (output channels
  built for the speakers, e.g. an 8th output pitch); `PIANOID_AUDIO_OUTPUT_MAP` then maps only the exciter channels and
  the speaker channels go to `PIANOID_SPEAKER_OUTPUTS` (`L,R` 0-based, default `0,1` = Out 1/2). *Borrowed* (none
  declared): `speakers` uses engine channels 0/1 and swaps the ASIO map live (Out 9/10 = E1/E2 become unmapped →
  silent); `dual` → 409 `dual_unavailable`. Mono on ONE channel is mirrored to the R output
  ([AUDIO_DRIVERS → output routing](../pianoid-cuda/AUDIO_DRIVERS.md#live-output-routing-and-mirrors-dev-rad1)).
* **Switch order:** entering a speaker target the map swaps first, leaving it the rows change first, so an exciter
  never receives the speaker mix. Both take effect at the next cycle; no preset reload.
* **State:** session (not saved), survives preset switches; a preset that cannot play the current target falls back
  to `board` with a printed warning.

| Route | Body | Result |
|---|---|---|
| `GET /output_routing` | — | `{target, layout, available{target:{layout: null or reason}}, speaker_channels, speaker_outputs, asio_map, asio_mirrors, basis, trim_db, radiance_source, provisional, plan?, gain?, gain_db?}` |
| `POST /output_routing` | `{target?, layout?}` | the new status; `409 {error, code}` (`dual_unavailable`, `layout_unavailable`, `rebuild_needed`, `asio_rejected`, `bad_request`), state unchanged |
| `POST /radiance/config` | `{basis?, trim_db?, speaker_channels?, source?, provisional?}` | status; merged into `model_parameters.radiance` (saved with the preset; write class `param_coarse`, not undoable) |
| `POST /radiance/import` | `{mono[N] or mono_db[N] (+reference_db, default median), stereo?[N][2], basis?, source?, provisional?}` | status + `imported_modes`; ONE undoable `mode` edit over all N modes, in mode order |
| `POST /radiance/from_frf` | `{frf_path, exciters?, speakers?, mic?, band_octaves?, layout? mono/L/R, apply?, source?, provisional?}` | the MEASURED absolute factors from a rig FRF + the LIVE model: `r[m] = sqrt(<\|Σ_c W[c,m]·H_mic←E_c(f)\|²> / <\|H_mic←spk(f)\|²>)` over a 1/3-octave band at the live mode frequency (mono: `H_spk = H_L + H_R`); `apply` writes them (one undoable `mode` edit) with `basis: absolute` |

Assistant: `output.get_mode`, `output.set_mode` (its own confirm rule), `radiance.import`, `radiance.from_frf`, `radiance.config`; factors via
`param.set` (`mode.radiance_mono` / `mode.radiance_left` / `mode.radiance_right`).

## Parameter Endpoints

### `GET /get_parameter/<parameter>/<key_no>`

Reads simulation parameters serialized for the frontend.

`parameter` values:
| Value | Description |
|-------|-------------|
| `string` | Physical string parameters |
| `mode` | Mode (resonance) parameters |
| `gauss` | Temporal excitation (hammer) — dictionary format |
| `gauss_flat` | Temporal excitation — flat array of 100 values |
| `gauss_full` | Temporal excitation — dictionary, all 128 velocity levels |
| `hammer` | Spatial excitation (hammer shape): `{p: {hammer: {hammer_width [m, STORED], hammer_width_effective [m, rendered = max(stored, 1.05·dx)], hammer_position [ratio of l_main], hammer_sharpness [0..1], hammer_shape, hammer_radius [derived]}}}`. **POST accepts this same shape** (dev-e772): GET → POST is the identity — read-only fields (`hammer_shape`, `hammer_radius`, `hammer_width_effective`) are ignored, a field equal to the stored value is not an edit (no upload, no Layer B stale), an unknown field → `416`; the flat `hammer_*` / bare `width`/`position`/`sharpness` keys are also accepted. A legacy sub-floor stored width (e.g. Belarus p60 0.00511 < 0.0106) is kept as stored until a REAL width edit, which floors it (A1; Tunner OVERVIEW dev-5150) — GET reports both values. Owner: `pianoid_middleware/hammer_payload.py` |
| `excitation` | Combined gauss + hammer |
| `feedin` | Deck feed-in coupling matrix |
| `feedback` | Deck feedback coupling matrix |
| `feedin_mask` / `feedback_mask` | **Persistent independent mute MASK** (F6) for the corresponding deck row — a `0/1` row of `num_modes` applied as a pure multiply at pack time (`Pitch.effective_deck` → `deck[m] × deck_mask[m]`); the raw values are left untouched, so unmute restores them bit-exactly. **Same pitch key space as the raw row it masks — including the output pitches** (see the key-space note below). This is how the Sound Channels panel mutes on the **strings** axis (`listen_to_modes=0`): `POST /set_parameter/feedback_mask/<128+ch>` |
| `output` | External sound output parameters (alias for feedback on output pitches) |
| `sound_channel` | Mode-coupling coefficients per pitch (modes-listen mode `listen_to_modes=1`). Effective rows: piano pitches `0..127` |
| `sound_channel_mask` | Persistent mute MASK for `sound_channel` — the **modes**-axis mute (`listen_to_modes=1`), keyed by **piano pitch** (not an output pitch) |
| `string_sound_channel` | Strings-mode gain per pitch (strings-listen mode `listen_to_modes=0`). Effective rows: **output pitches `128..127+num_output_channels` only** — POSTing to a piano-pitch `<key_no>` (0..127) updates the Python store but the kernel never reads those rows. This is a SEPARATE table from the one the Sound Channels editor edits (the editor writes `feedback` / `feedback_mask` at `128+ch` and `sound_channel` / `sound_channel_mask` — see [Sound-channel editing](#sound-channel-editing-what-the-frontend-uses); the FE never sends `string_sound_channel`). Its output rows are addressed with `key_no=output` (whole table: measured `GET` and `POST …/string_sound_channel/output` → 200); a single numeric output key (`…/string_sound_channel/129`) → `416`, because `string_sound_channel` is not in `OUTPUT_PITCH_RAW_PARAMS` (same on `dev`). See `docs/modules/pianoid-basic/OVERVIEW.md` "Stored vs effective entries" for the data-model contract |
| `stability_ratio` | **Read-only.** Per-pitch FDTD CFL/Courant stability ratio = `max_θ|g(θ)|` (`CFL_LIMIT = 1`); `ratio ≤ 1` is stable (a lossless string sits at exactly `1.0`). Per pitch: `{ratio, stable, strings:[{string_index, ratio, stable}]}`, plus a top-level `_meta {cfl_limit, criterion, formula}`. **Computed HOST-side** (v2) from the current `StringMap` physics via the closed-form `cfl_stability.max_amplification` (no GPU round-trip, no debug build), honouring the per-string `tension_offset`; output/"sound" strings (pitch ≥ 128) report the sentinel `1.0`/stable. Analyst-plottable vs pitch (`key_no = "all"`, `"output"`, or `"from21to108"`). Derivation: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "FDTD Stability (CFL / Courant) Bound"; design `docs/proposals/cfl-stability-guard-v2.md`. `POST` to this parameter is not supported |

**Pitch key space — which parameters may address the OUTPUT pitches** (`parse_range`, dev-mute2 2026-07-12).
Most parameters accept **piano pitches only** (the preset's key range, e.g. `23..106`). The **output**
(sound-channel) pitches `128..127+num_output_channels` are a *disjoint* key space, and only the parameters
declared in `backendServer.OUTPUT_PITCH_RAW_PARAMS` — currently `feedback` — plus their **derived
`_mask` kinds** (`feedback_mask`) may be keyed by one. Anything else POSTed to `128` is rejected
**`416`** (`"Wrong range for pitches…"`).

> The `_mask` kinds are *derived*, never hand-listed: **a `<param>_mask` addresses exactly the same pitch
> key space as the raw `<param>` it masks** — a mask that cannot address the row it masks is unwritable.
> Enforcing that structurally is deliberate. When the F6 mask kinds were first added, the hatch was a
> hardcoded `parameter == 'feedback'` test, so `feedback/128` returned `200` while `feedback_mask/128`
> returned `416` — **every strings-axis mute (and unmute) was silently rejected and the operator's "mute
> everything" did nothing at all.** Regression: `PianoidCore/tests/unit/test_parse_range_output_pitches.py`;
> RCA: `docs/development/reviews/sound-channel-mute-logic-rca-2026-07-12.md`.

`key_no` formats:
- Integer string: `"57"` — single pitch or mode number
- `"all"` — all pitches or all modes (depending on parameter type)
- `"output"` — output pitches only (accepted for any parameter; returns the output rows — note this GET
  branch bypasses the per-parameter key-space check, which is why the mask could always be *read back*
  from `128..131` even while every *write* to it was rejected `416`)
- `"from<N>to<M>"` — inclusive range, e.g. `"from21to88"` (or `"from128to131"` for the output rows)

For `mode`: `key_no` is a **mode** number range. For every other parameter — **including `feedin`,
`feedback` and the masks** — `key_no` is a **pitch** number range, and the payload row is indexed by mode
(`len = num_modes`). (This page previously said feedin/feedback were mode-keyed; that was wrong.)

#### Parameter key spaces — Data Model Card (measured, dev-960f I0)

Measured on a live backend (BaselinePreset1, 100 modes, piano pitches 23..106, output pitches 128..131;
`docs/development/diagnostics/dev-960f-i0-keyspace.py`, 19/19 PASS). These are the key spaces the
[State events](#state-events-ssot-i1) `keys` use.

| Domain | `key_no` / event `keys` | Row / value | Stored vs effective | Evidence |
|---|---|---|---|---|
| `feedin`, `feedback` | piano **pitch**; `feedback` also output pitches 128+ | `[num_modes]` per pitch | raw row stored; effective = raw × mask at pack time | POST feedin/57 → only row 57 changed in `…/all`; `feedin/3` (a mode, not a pitch) → 416; `feedback/128` 200, `feedin/128` 416 |
| `feedin_mask`, `feedback_mask` | same key space as the raw row it masks | `[num_modes]` 0/1 | the mask itself; raw untouched | mask write left `GET feedback/57` bit-identical; `feedback_mask/128` 200 |
| `mode` | **mode** number | `{field: value}` | stored | POST mode/5 → only mode 5 changed |
| `string` / `physics` | piano pitch | `{field: value}`; `length` in metres | `tail` DERIVED (= length/10), never independently stored | length edit re-derived `tail` |
| `hammer` | piano pitch | `{hammer: {…}}` | `hammer_width` stored; `hammer_width_effective` (rendered) + `hammer_radius` derived, read-only | GET 60: stored 0.00511 vs effective 0.010605 |
| `sound_channel`, `sound_channel_mask` | piano pitch | `[num_channels]` | stored | row length = `_meta.num_channels` |
| `string_sound_channel` (FE-unused per-channel strings-mode gain table) | piano pitch by number; its output rows via `output` (whole table) | `[num_channels]` | effective rows 128+ only | `…/output` GET + POST 200; a numeric `…/129` → 416 (not an output-pitch param) |
| `runtime` | field names | bare values | engine `volume_center` = bare × `output_scale` | eff = bare × scale (rel err < 1e-6) |

#### Sound-channel editing (what the frontend uses) {#sound-channel-editing-what-the-frontend-uses}

Channel editing WORKS and is unchanged by dev-960f. The Sound Channels editor (`usePreset.js`
`changeSoundChannelFeedback` / `changeSoundChannelValues` / the mask emitters, `useSoundChannels.js`
`emitOneStringsRow*` adding `OUTPUT_PITCH_OFFSET = 128`) sends, all over REST:

| Editor action | Request (exact FE form) | Event (dev-960f) |
|---|---|---|
| strings axis (`listen_to_modes=0`), channel `ch` row | `POST /set_parameter/feedback/<128+ch>` `{"<128+ch>": [num_modes]}` | `state_changed{feedback, keys [128+ch]}` |
| strings axis mute | `POST /set_parameter/feedback_mask/<128+ch>` `{"<128+ch>": [0/1…]}` | `state_changed{feedback_mask}` |
| strings axis whole matrix | `POST /set_parameter/feedback/output` `{"128": […], …}` | `state_changed{feedback, keys [128..]}` |
| modes axis (`listen_to_modes=1`), pitch `p` | `POST /set_parameter/sound_channel/<p>` `{"<p>": [num_channels]}` | `state_changed{sound_channel}` |
| modes axis mute | `POST /set_parameter/sound_channel_mask/<p>` | `state_changed{sound_channel_mask}` |

Measured on `dev` (fa291d5) AND this branch with the same script
(`docs/development/diagnostics/dev-960f-sc-edit.py`, BaselinePreset1): every request 200, GET
read-back == written (a mask write leaves the raw row untouched), all of it survives `/save_preset` →
full reload of the saved file, the saved JSON is identical between the two backends except
`output_scale` (calibration-render noise, 3.9e-5 relative), and a p60 render with the edited channels
matches between them (rel. max diff 4.9e-5, corr 0.999999999). The I0 note about `416` concerned only the
FE-unused `string_sound_channel` table addressed with a numeric output key — never the editor's path.

**`string` parameter — `length` unit.** For `parameter == string` (and `physics`),
the `length` field is the main-section physical length in **metres**
(`p_main * dx`), *not* the FDTD block count. `PhysicalParameters.pack()` stores
`p_main()` (the unitless block/discretisation-point count) in that slot; the
serializer multiplies by `dx` so the endpoint reports metres — the same unit the
`combined` branch reports and the same unit `geometry.set_length()` expects. A
`length` value POSTed back via `set_parameter/string` is therefore interpreted as
metres, making the GET→edit→POST round-trip unit-consistent. (Returning the raw
block count here previously made the granular path upload `dx ≈ 1.0 m`, an ~84-141x
error that diverged the FDTD solver — fixed in `cce4270`.)

Response `200`: parameter payload (structure depends on parameter type)

Response `416`:
```json
{"message": "Error parsing parameters, parcer error, <details>"}
```

---

### `POST /set_parameter/<parameter>/<key_no>`

Writes simulation parameters. Same `parameter` and `key_no` semantics as `GET /get_parameter`.

Request body: parameter payload in the same structure returned by the corresponding GET.

Response `200`:
```json
{"message": "OK"}
```

Response `400` — parameter safety net (`parameter_out_of_range`, nothing written; see
[Parameter safety net](#parameter-safety-net-out-of-domain-rejection) below).

Response `400` — a malformed `feedin_mask` / `feedback_mask` write (dev-fcef, follow-up l; owner
`pianoid_middleware/mask_rows.py`): every pitch of `key_no` needs a row of exactly `num_modes` values.
Checked before anything is written; it rejects exactly the writes StringMap used to fail with a 416 +
Python traceback (measured in the 2026-10-16 assistant session 2c86b530: rows of 3 / 198 values for 196
modes, a range with one row only). WS `set_parameter` returns the same message in its `error`.
```json
{"error": "invalid_mask_row", "parameter": "feedin_mask", "expected_length": 196, "problem_count": 2,
 "problems": [{"pitch": 21, "problem": "3 values"}, {"pitch": 22, "problem": "no row"}],
 "message": "feedin_mask: every pitch of the range needs a row of exactly 196 0/1 values (num_modes); ..."}
```

Response `400` — a `string` / `physics` / `gauss` / `excitation` write whose `values` has no entry for some
pitch of `key_no` (report bc956d19, dev-obuf1; owner `pianoid_middleware/pitch_values.py`). Checked before
anything is written: it used to `KeyError` half-way (416 + traceback) after the earlier pitches were already
in the Python model, the engine upload never ran and no undo group was recorded (model and engine diverged).
WS `set_parameter` returns the same message in its `error`.
```json
{"error": "missing_pitch_values", "parameter": "string", "missing_pitches": [60], "missing_count": 1,
 "message": "string: values has no entry for pitch 60 of the key range. Give a value for every pitch of key_no, or narrow key_no. Nothing was written."}
```

**Every keyed write is all-or-nothing (dev-mpart1, same owner).** Each `set_parameter` family checks its
whole payload before its first model write, so a rejected write leaves the model AND the engine untouched
and records no undo / journal entry:

| Parameter | Key coverage (`key_no` = the range) | Entry check | Error |
|---|---|---|---|
| `mode` | every **mode** of `key_no` (`all` = every mode) | `{field: number}` | `missing_mode_values` (`missing_modes`) / `invalid_values` |
| `string`, `physics` | every pitch | `{field: number}` (`hammer_shape` may be a name) | `missing_pitch_values` / `invalid_values` |
| `gauss`, `excitation` | every pitch | `{level: {curve: {mu, sigma, volume, shift: number}}}` | same |
| `feedin`, `feedback` | every pitch | row shape: StringMap, before writing | `missing_pitch_values` |
| `feedin_mask`, `feedback_mask` | every pitch | `num_modes` 0/1 values (above) | `invalid_mask_row` |
| `sound_channel`, `sound_channel_mask`, `string_sound_channel` | none (a pitch without a row is skipped) | each given row = `num_channels` numbers | `invalid_values` |
| `hammer` | none (skipped) | `hammer_payload.hammer_edit`, all pitches before writing | 416 (atomic; not yet a 400) |

Before dev-mpart1 (measured on dev a2659d2, isolated backend, `dev-mpart1-mode-partial-write.py`):
`mode` `key_no=all` with 25 of the modes wrote those 25 into the model, answered 416 `KeyError '25'`, and the
`note_playback` render did not change (rel 2.3e-4 = render noise; the same values via `from0to24`: 1.4e-2):
model ≠ engine until the next full reload (a preset *switch* copies device buffers only). A non-number
(`string` / `mode` / `gauss`) or a wrong-length sound-channel row did the same part-way. Now each is 400 with
nothing written; a GET → POST round-trip of every family (`all`) still answers 200.
```json
{"error": "missing_mode_values", "parameter": "mode", "missing_modes": [25, 26, "..."], "missing_count": 14,
 "message": "mode: values has no entry for mode 25, ... of the key range. Give a value for every mode of key_no, or narrow key_no. Nothing was written."}
{"error": "invalid_values", "parameter": "string", "key_kind": "pitch", "problem_count": 1,
 "problems": [{"pitch": 60, "problem": "damper_string='abc' is not a number"}], "message": "..."}
```

Response `416`:
```json
{"message": "Wrong parameter request"}
```
or
```json
"Set parameter route: Internal error in module pianoid.py: <traceback>"
```

#### Parameter safety net (out-of-domain rejection)

Evaluator `pianoid_middleware/param_safety.py`; the rules are **data**, the [parameter rule table](#parameter-rule-table)
(dev-psafe2, 2026-10-28; rules reviewed in dev-psafe1, port of Core `14fd5af` / dev-9a47).
`edit_commit.commit` runs `check_edit` for **every** preset-parameter edit — REST and WS
`set_parameter`, `set_string_excitation`, `set_hammer_shape`, the assistant's `param.set` (it calls this
route), `/mute/*`, `/excitation_energy`, the calibration commits, MIDI CC, the auto-tuner, and undo /
redo. The check runs before the undo step opens and before anything is written. A rejected edit changes
nothing in the model, the engine, the journal or the undo history. The runtime fields
(`/set_runtime_parameters`, `runtime.*`) and the `POST /load_preset` load settings (`load_settings.*`)
go through the same table, and preset loads are checked too (below). Nothing runs on the audio path.

A default rule rejects a value only when the engine can't run it as a piano. That means one of these:

- it isn't finite;
- the arithmetic is undefined for it (division by zero);
- it makes a resonator grow instead of decay;
- it is outside the definition of a quantity that is positive by definition.

There are **no magnitude caps** in the defaults: the dev-2706 directive stands. The FDTD **Courant/CFL**
bound of a physical string stays an indication (`cfl_redline` on a `200`), never a rejection (user
decision 2026-07-08). Each bound's justification is in
`docs/development/reviews/param-safety-net-review-2026-10-28.md`. Every rule can be relaxed, tightened or
disabled by the user ([rule table](#parameter-rule-table)); the table below shows the **defaults**.

| Rule id(s) | `parameter` · field | Rejected unless (default) |
|---|---|---|
| `finite` | any · every numeric leaf, numeric strings included | finite (not NaN / ±Inf) |
| `mode.frequency`, `mode.frequency.nyquist` | `mode` · `frequency` | `0 < frequency ≤ sr/π` (`frequency / (sr/π) ≤ 1`: the played Nyquist of the mode recurrence, 15 279 Hz at 48 kHz) |
| `mode.decrement`, `mode.decrement.per_sample` | `mode` · `decrement` (`true_decrement`) | `≥ 0` **and** `decrement · frequency / sr < 1` (checked against the mode's prospective state, so a `frequency` edit can trip it) |
| `mode.mass_inv` | `mode` · `mass_inv` (legacy `mass`) | `> 0` |
| `string.rho`, `string.length`, `string.dx` | `string` / `physics`, piano pitch < 128 · `rho` (`string_density`), `length`, `dx` | `> 0` |
| `excitation_energy.hammer_mass` | `excitation_energy`, and `hammer_mass` of a string edit, piano pitch | `(0, 1]` kg |
| `string.r`, `string.gamma`, `string.dispersion_damping`, `string.damper_string`, `string.damper_tail` | same · `r`, `gamma`, `disp_decay`, `damper_string`, `damper_tail` | `≥ 0` (`string.jung` is finite-only: every shipped preset stores it negative) |
| `string.tension` | same · `tension`, `tension_offset` (`detuning`) | every unison string's `tension · (1 + i · tension_offset) > 0` |
| `hammer.hammer_position` · `hammer.hammer_sharpness` · `hammer.hammer_width` | `hammer`, and `hammer_*` keys of a string edit | `[0, 1]` · `[0, 1)` · `≥ 0` |
| `gauss.level` · `gauss.curve` · `gauss.sigma` | `gauss` / `excitation` / `string_excitation_curves` · level key · curve key · `sigma` | integer `0..127` · integer `0..4` · `> 0` (`gauss.mu` / `gauss.volume` / `gauss.shift`: finite only, `volume` is signed in FPGA presets) |
| `sound_channel`, `string_sound_channel` | row | exactly `num_channels` values (the stored row length) |
| `excitation_energy.hammer_speeds` · `excitation_energy.excitation_impulse_calibration` · `deck_feedback_coefficient.store_feedback_coeff` | `excitation_energy`, `deck_feedback_coefficient`, preset load | `≥ 0` · `> 0` · `≥ 0` |
| `runtime.volume` · `runtime.feedback`, `runtime.feedback_coeff` · `fix_velocity.level` | `/set_runtime_parameters` · `/set_fix_velocity` | `0..127` · `≥ 0` (no upper bound) · integer `0..127` |
| finite-only entries | `feedin`, `feedback`, masks, other `runtime.*`, `load_settings.*`, … | finite (feedin / feedback / mask **row shape** stays with `StringMap.update_deck` / `mask_rows`: structural, not a value domain) |

No value range is checked anywhere else: `excitation_energy.normalize`, `runtime_params` and `set_fix_velocity` keep only payload shape / type checks, so relaxing a rule relaxes the write path end to end (dev-psafe2). `amplitude_limit` is still clamped into `1..1e7` by `runtime_params` (a clamp, not a rejection).

Output pitches (≥ 128) are exempt from the `scope: piano` rules (string, hammer, `sigma`) because they
carry placeholder physics (`tension` / `r` / `length` / `gamma` = 0). They still get the finite check.

Response `400` (REST) or an `error` event plus `{ok: false, …}` ack (WS), with the same body. `rule` is
the id of the violated rule (find it in Settings → Parameter rules, or `GET /param_rules?id=<rule>`):

```json
{"error": "parameter_out_of_range", "code": "parameter_out_of_range", "rule": "mode.decrement",
 "parameter": "mode", "field": "decrement", "mode": 0, "value": -1.0, "bound": ">= 0",
 "message": "mode.decrement=-1.0 for mode 0 rejected by rule 'mode.decrement': must be >= 0 (negative damping: the mode grows exponentially). Nothing was written."}
```

The key is `pitch` or `mode`, depending on the parameter. A non-finite `value` comes back as a string
(`"nan"`) so that the body stays strict JSON. `/set_runtime_parameters` answers its usual
`400 {error: <message>}` with the same message (rule id included).

**Preset loads.** `POST /load_preset` builds the preset's model at the requested `sample_rate` (Hz, or
kHz when `< 1000`, the same rule as the route) and checks it with `check_model` (the same table). It does
this for every reload except `hot` (hot reloads keep the same model), and **before** the live engine is
re-initialised or torn down. On a failure it returns `400` with the same body (`parameter` = `preset`)
plus `"The preset was not loaded; the loaded engine keeps running."`. `POST /preset/load` (library) runs
the same check before the GPU slot is created. Because the mode bound follows the sample rate, a preset
with modes near 9.5 kHz loads at 48 kHz but is refused at 24 kHz. Every shipped preset passes under the
defaults (`tests/unit/test_param_safety.py` preset scan).

#### Parameter rule table

Owner `pianoid_middleware/param_rules.py` (`RuleTable`, dev-psafe2). **Defaults** ship versioned in
`pianoid_middleware/param_rules.json`: one record per parameter of the [parameter inventory](#get-paraminventory)
(a completeness test pins it) plus the global `finite` rule. **User overrides** persist in a git-ignored
file outside the repos — `$PIANOID_PARAM_RULES`, else `<PianoidInstall>/param_rules_overrides.json` (the
MIDI-settings pattern) — and survive a backend restart. An unreadable or invalid stored override is
ignored with a log line.

| Record field | Meaning |
|---|---|
| `id` | the rule id a rejection names (`<domain>.<field>`, plus the `.nyquist` / `.per_sample` relations, and `finite`) |
| `family` · `parameter` · `field` | grouping (`general`, `mode`, `string`, `hammer`, `excitation`, `coupling`, `runtime`, `derived`, `load`) · the inventory domain + field |
| `kind` | `finite` (NaN / Inf; a disabled per-parameter finite entry exempts its targets, disabling `finite` itself switches the check off everywhere) · `bound` (the value in `[min, max]`) · `relation` (a named check computes `expression` from the prospective state; that value must be in `[min, max]`) · `shape` (a named structural check, enable only) |
| `min` / `max` · `min_inclusive` / `max_inclusive` | `null` = unbounded |
| `check` · `expression` | the relation / shape name in `param_safety.RELATIONS` / `SHAPES` · its human-readable form |
| `targets` · `scope` | payload addresses `<kind>.<field>` the rule applies to (`[]` = read-only / owner-typed, listed for completeness) · `piano` = pitches < 128 only |
| `enabled` · `reason` · `doc` | on / off · why the bound exists · doc anchor |

Only `enabled`, `min`, `max`, `min_inclusive` and `max_inclusive` are mutable (bounds only on `bound` /
`relation` rules). Every change is logged (`param_rules: rule <id> changed by <source>: <before> -> <after>`)
and broadcast as `session_changed {domain: "param_rules", keys: [<id>]}` (`write_routes` class `session`).

| Route | Body | Response |
|---|---|---|
| `GET /param_rules` | `?family=` · `?id=` (optional filters) | `{version, overrides_path, families, overridden: [ids], warnings, rules: [{…static fields, default: {enabled, min, max, min_inclusive, max_inclusive}, current: {…}, overridden}]}`; `404 unknown_rule` |
| `PUT /param_rules/<id>` | any of `{enabled, min, max, min_inclusive, max_inclusive}` | `{rule, warnings}`; `400 invalid_rule_change` (unknown / immutable key, non-boolean flag, NaN / Inf / non-number bound, bounds on a finite / shape rule, `min > max`, `min == max` with an exclusive end — nothing changed); `404 unknown_rule` |
| `POST /param_rules/<id>/reset` | — | `{rule, warnings}` (back to the default) |
| `POST /param_rules/reset` | — | the full table (every override removed) |

Disabling `finite` is allowed but warned: `warnings` carries *"The 'finite' rule is disabled: NaN / Inf
values now reach the model and the GPU buffers unchecked …"* on every GET / PUT until it is re-enabled,
and the backend logs it at load. The assistant reads the table with `param.rules` (`view` category,
read-only). The Tunner edits it in **Settings (⚙) → Parameter rules**.

**CFL / Courant (indication only).** A string edit whose FDTD amplification `max|g| > 1` or whose
Courant number is `≥ CFL_MARGIN` is **applied**. The response is `200` with `cfl_redline: true` and
`cfl_redline_info`, and the flag also appears on `/health` (v3, 2026-07-08; see
[PARAMETER_SYSTEM](../pianoid-cuda/PARAMETER_SYSTEM.md#host-side-cfl-stability-gate-physical-params--granular-path)).
The `CflRejected` / `cfl_unstable` 400 handler remains for a host gate, but the edit paths no longer
raise it.

---

### Mute operations (dev-0a88)

Whole-row mask writes for the two common mutes, so a caller never hand-builds `num_modes`-long
rows (owner `pianoid_middleware/mute_ops.py`, tests `tests/unit/test_mute_ops.py`). Each request
reads the current masks, changes only what it names and writes through the same choke point as
`POST /set_parameter/<mask>/<range>` (`write_routes` class `param`): ONE request = ONE undo group,
`state_changed` to every editor, the read-only guard (409 on an original).

| Route | Body | Writes |
|---|---|---|
| `POST /mute/modes` | `{modes, pitches = "all", side = "both", action = "mute"}` | `feedin_mask` and / or `feedback_mask` rows of the piano `pitches` (never the output pitches): the named `modes` set to 0 (`mute`) / 1 (`unmute`), or `solo` = the named modes 1 and every other mode 0 |
| `POST /mute/channels` | `{channels, action = "mute"}` | the mask that mutes an OUTPUT channel for the loaded preset (below), each channel row written whole: `mute` = 0, `unmute` = 1, `solo` = the named channels 1, the others 0 |

`modes` / `pitches` / `channels`: `"all"`, `n`, `"from<a>to<b>"` or a list (0-based channels).
`side`: `feedin` · `feedback` · `both`. `action`: `mute` · `unmute` · `solo`.

**Which mask is a channel** (see [Sound-channel editing](#sound-channel-editing-what-the-frontend-uses)):
`listen_to_modes = 0` (strings axis, e.g. the F15 FPGA / measured presets) → the `feedback_mask`
row of output pitch `128 + ch`; `listen_to_modes = 1` (modes axis) → column `ch` of
`sound_channel_mask` on every piano pitch. Writing the other one is a silent no-op for the
sound (measured in the 2026-10-16 assistant session: `sound_channel_mask` "channel 0 only" on a
`listen_to_modes = 0` preset changed nothing). `unmute` / `solo` clear the channel's own per-mode
mutes (the row becomes all 1).

Response `200`: `{message: "OK", action, written: [<mask>…]}` plus, for modes,
`{modes: [...], pitches: [first, last], side}` and, for channels, `{axis: "strings" | "modes",
parameter, channels, channels_on, num_channels, listen_to_modes, output_pitches?}` (`channels_on`
= the channels with any mask value 1 after the write). `400 invalid_mute_request` (bad
action / side, an index out of range — nothing written), `400` no preset loaded, `416` a write
the choke point rejected.

### `POST /set_string_excitation/<pitch_no>`

Sets temporal excitation curves for a single pitch at one velocity level.
Delegates to `update_pitch_excitation()` which updates the Python model and GPU.

`pitch_no`: integer pitch ID

Request body:
```json
{
  "level": 2,
  "curves": {
    "0": {"sigma": 0.01, "mu": 0.5, "volume": 1.0, "shift": 0.0},
    "4": {"sigma": 0.02, "mu": 0.5, "volume": 0.8, "shift": 0.1}
  }
}
```

Response `200`:
```json
{"message": "String excitation set successfully"}
```

Response `400` `parameter_out_of_range` — see [Parameter safety net](#parameter-safety-net-out-of-domain-rejection)
above: `sigma <= 0`, a curve key outside `0..4` and NaN/Inf in any curve field are rejected before anything is written.

---

### `POST /set_hammer_shape/<pitch_no>`

Sets hammer geometry for a single pitch. Null values in the JSON body are silently
ignored. Delegates to `update_parameter('hammer', ...)`.

`pitch_no`: integer pitch ID

Request body:
```json
{
  "shape": "circular",
  "width": 0.012,
  "position": 0.09,
  "sharpness": 0.7
}
```

Response `200`:
```json
{"Message": "OK", "Width": 0.012}
```

---

### `GET /get_hammer_shape/<pitch_no>`

Read-only. Returns the **exact per-spatial-node hammer excitation** the engine
applies to this pitch's string — the literal value at every FDTD grid node — plus
the spatial geometry needed to place those nodes on the string. Reads the in-memory
`pitch.physics.hammer.hammer_shape` numpy array, which is computed at preset load and
recomputed on every hammer edit (`set_hammer_shape` → `_apply_parameter_request` →
`Hammer.calculate_hammer_shape`). **No CUDA/GPU round-trip** — reflects host-side model
state. Added dev-gausscp (2026-06-16) to drive the frontend hammer chart's discrete
("exact string nodes") zoom view.

`pitch_no`: integer pitch ID. Unknown / non-integer pitch → `416`.

Response `200`:
```json
{
  "pitch": 100,
  "shape_type": "circular",
  "values": [0.0, 0.00099, 0.00501, 0.00465, 0.0, ...],
  "node_positions": [0.0, 0.005696, 0.011392, 0.017088, ...],
  "geometry": {"l_main": 0.0911, "dx": 0.005696, "p_full": 22, "p_main": 16, "tail": 4},
  "params": {"hammer_shape": "circular", "hammer_width": 0.00707,
             "hammer_position": 0.15, "hammer_sharpness": 0.5, "hammer_radius": 0.0448}
}
```

**Index/units contract:** `values[xi]` is the engine excitation (string displacement,
metres) at grid node `xi`, located at `node_positions[xi] = xi * dx` metres from the
start of the string. `len(values) == geometry.p_full == p_main + tail + STEM_LENGTH (2)`.
The hammer is centred at `params.hammer_position * geometry.l_main` metres
(`hammer_position` is the ratio in `[0,1]`, matching the value the frontend already
consumes). `width` is metres; `sharpness` is `[0,1]`. At default `array_size` a real
preset hammer is **sparse** (only a few nonzero nodes), which is the honest physical
shape.

Response `400` when pianoid is not initialized; `416` for an unknown/invalid pitch or
an internal retrieval error.

---

### `POST /set_mode_parameters` — RETIRED (dev-960f)

Removed (404). It wrote mode objects + a bulk mode upload outside the write machinery (no Layer B
policy, no state event), had no caller, and had been broken on `dev` (every call 500: `'ModeMap' object
is not subscriptable`). Use `POST /set_parameter/mode/<key_no>`.

---

### Fix-MIDI velocity clamp

The Fix-MIDI clamp lets the user pin every incoming MIDI NOTE_ON to a single
velocity, regardless of how hard the key was pressed. State lives on the
running engine — runtime/session scope, NOT preset-persisted, NOT reset on
preset switch, reset to defaults on backend restart (option B per
dev-bv01 user direction, 2026-05-03).

**Source-flag protocol.** REST `/play` and WS `play` accept an optional
`source` field. The clamp applies ONLY when `source == "midi"`. Non-MIDI
callers (virtual piano, space-bar, Excitation editor, calibration paths)
omit the flag and preserve their explicit velocity.

**Single canonical helper.** Every clamp goes through
`Pianoid.apply_fix_velocity(velocity)` — there is no parallel mechanism. The
helper is called from:

| Ingress | Clamp gate |
|---|---|
| REST `POST /play` with `source: "midi"` | `pianoid.apply_fix_velocity` (gated by source flag) |
| REST `POST /play` without `source` | NOT clamped |
| WS `play` event with `source: "midi"` | gated by source flag (same as REST) |
| WS `play` event without `source` | NOT clamped |
| `Pianoid.schedule_event(...)` (default `apply_fix_velocity=True`) | unconditional clamp for NOTE_ON — used by the unified MIDI listener (`MIDI_listener_unified`, the `listen_to_midi=1` backend path) |
| Legacy `pianoidMidiListener` `note_on` | calls `apply_fix_velocity` directly |
| `Pianoid.perform_midi_command(...)` | defaults `apply_fix_velocity=False` — preserves backward compat for NoteTunner calibration / `set_sustain` |
| `/play_keyboard` (online + offline) | passes `apply_fix_velocity=False` — deterministic diagnostic sweep, never clamped |
| `/measure_rms`, `/tune_note`, `/calibrate_volume`, `/equalize_keyboard` | NOT clamped — calibration depends on explicit velocity |
| `/play_mode/<mode_no>` | N/A — uses internal synthesis path, not MIDI velocity |
| `note_playback` chart (offline render) | NOT clamped — strict-A1 audio_off determinism |

This collapses three pre-refactor parallel mechanisms (`pianoid.fixed_velocity`,
`pianoid.fixed_level`, frontend `midiPlayNote` JS rewrite) into one canonical
owner. Closes the listen_to_midi=1 sidestep where the backend MIDI listener
bypassed the JS clamp.

---

### `POST /set_fix_velocity`

Sets the Fix-MIDI velocity clamp state. Both fields required.

Request body:
```json
{"enabled": true, "level": 95}
```

- `enabled` (bool, required): when `true`, MIDI-source NOTE_ON velocities are
  clamped to `level`. When `false`, MIDI velocities pass through.
- `level` (int 0-127, required): the clamped velocity value. `0` is allowed
  (silent note); `127` is allowed (fortissimo).

Response `200`:
```json
{"message": "OK", "fix_velocity": {"enabled": true, "level": 95}}
```

Response `400` cases:
- `Pianoid not initialized`
- `Body must be a JSON object`
- `Both 'enabled' and 'level' are required`
- `enabled must be bool`
- `level must be int`
- `level must be 0-127, got <N>`

Symmetric WS event: `set_fix_velocity` accepts the same payload and emits
`param_ack` with `{parameter: "fix_velocity", status: "ok", updated: {...}}`.

---

### `GET /get_fix_velocity`

Returns the current Fix-MIDI velocity clamp state. Used by the frontend
`useFixVelocity` hook on mount and on `presetVersion` bumps to mirror the
backend state into the UI.

Response `200`:
```json
{"enabled": false, "level": 64}
```

Response `400` if `Pianoid not initialized`.

Defaults at backend start: `{enabled: false, level: 64}` (mf). Defaults
restore on backend restart only — preset switches preserve the runtime
state per option B.

---

### `GET /get_excitation_mode`

Read-back of the per-pitch excitation TYPE (Universal-Excitation Phase 2) for every pitch of the active
preset — `0` = hammer (impulse, one-shot), `1` = bow (sustained). Session state on the live engine (not
preset-persisted). The frontend `useExcitationModes` hook hydrates from it on mount, on `presetVersion`
bumps and on an I2 resync; live edits arrive as `session_changed{domain: 'excitation_mode', keys: [pitch],
after: {pitch: 0|1}}` (written by `POST /set_excitation_mode {pitch, mode: "hammer"|"bow"|0|1}`).

Response `200`:
```json
{"modes": {"21": 0, "22": 0, "60": 1}}
```

Response `400` if `Pianoid not initialized`. Classified `read_only` (records no event).

---

### `POST /set_runtime_parameters`

Updates volume and/or deck feedback coefficient while the engine is running.

Request body:
```json
{
  "volume": 80,
  "feedback": 64,
  "volume_center": 1000.0,
  "volume_range": 25.0
}
```

`volume`: integer 0–127 (MIDI range). Maps to amplitude coefficient using either the legacy formula `max_volume^(level/127)` (when `volume_center == 0`) or the per-session sensitivity formula `volume_center * volume_range^((level-64)/63)` (when `volume_center > 0`).

`feedback` auto-detection:
- `0.0` — silence (no deck coupling)
- `1`–`127` — MIDI-style exponential mapping: 64 → 1.0, 127 → 8.0, 1 → ~0.125
- Outside `1`–`127` (e.g. `2.5`) — used as direct coefficient

Valid coefficient after mapping: any finite value `>= 0` (no upper bound since dev-e591; negative / NaN / inf → error). The engine (`Pianoid::setRuntimeParameters`) applies the same rule (finite, `>= 0`); before dev-e591 it rejected `> 1000`, so the slider stopped having an effect at 1000.

`feedback_coeff` (optional, float, dev-fbsl 2026-06-05): a DIRECT effective deck feedback
coefficient that BYPASSES the `feedback` level mapping above. Used by the two-layer
feedback slider, which composes `effective = stored_coeff(preset) × env_multiplier(slider)`
frontend-side and sends the product here. Calls `set_deck_feedback_coefficient(value)`
directly. Any finite value `>= 0`, no upper bound (negative / non-finite → error). Scales PIANO-pitch resonance feedback only (the dev-d52b
`dev_feedback_output_mask` keeps sound-channel/output rows ≥128 at ×1).

`store_feedback_coeff` (optional, float, dev-fbsl 2026-06-05): the "Set" / fold button writes
the new PER-PRESET stored feedback baseline IN MEMORY (`pianoid.mp.deck_feedback_coefficient`)
— NO disk I/O. The value is persisted to the preset file only on `/save_preset` (it rides
`mp.pack()` → `model_parameters.deck_feedback_coefficient`). Any finite value `>= 0`, no upper bound (negative / non-finite → error). The stored
baseline is per-preset: `switch_preset` applies the target preset's value (it is no longer
global; volume + volume-sensitivity remain global). Being PRESET data it goes through the write
machinery (dev-960f): `409 preset_read_only` on a read-only original, and it is broadcast as
`state_changed{domain:'deck_feedback_coefficient'}` keyed to the active entry (the other fields of
the same request stay a `runtime` event).

`deck_scaling` (optional, object `{feedin_coeff, feedback_coeff, feedbackOFF}`, dev-960f): an
engine-only re-pack of the deck with these factors (the legacy MIDI CC feedin / feedback knobs); the
stored rows are untouched and `{}` restores the unscaled deck. Recorded as `runtime`.

`volume_center` (optional, float): coefficient at level 64, in **bare** units (the frontend sends `exp((presetVolume-100)/8)`, `1.0` at the default init volume). The engine stores `volume_center × output_scale` (Layer B); the ack (`updated.volume_center`) and `GET /get_runtime_parameters` report the bare value back, plus `effective_volume_center` (the engine value). `0` selects the legacy `max_volume^(level/127)` formula. Non-zero enables the new sensitivity formula.

`volume_range` (optional, float): "sensitivity" multiplier. At level 127 the coefficient is `center*range`; at level 0 it is `center/range`. **Default = 10**, matching the C++ `RuntimeParameters` engine default in `Pianoid.cuh`. **Per-session only** — never persisted in preset JSONs. **Global across library preset switches** (plan §5.9, dev-bfe2 2026-05-18): `switch_preset` snapshots and restores `volume_range` unchanged (the pre-§5.9 "reset to 10 on switch" behaviour is gone).

`max_volume` (optional, float > 0): the legacy-formula ceiling (InitializationParameters.max_volume); it changes the coefficient only while `volume_center == 0` (legacy formula). Written read-modify-write (dev-2fbf): `setInitializationParameters` replaces the whole struct, and the former fresh-struct write zeroed the structural fields and silenced the live engine (measured p60 peak 0).

`amplitude_limit` (optional, float, dev-538e): the **runtime amplitude crash-guard ceiling** — the in-kernel string-displacement guard trips (self-heals) when a string point's `|displacement| > amplitude_limit`. Replaces the former compile-time `constexpr AMPLITUDE_LIMIT`. **Default `1.0e4`** (behaviour unchanged from the constexpr unless edited). **Accepted range `1.0 .. 1e7`, CLAMPED** into range (the floor is `1.0`, not the default, so the value can be driven BELOW the loudest healthy internal displacement to deliberately force/observe the gate — an observability & control lever; `1.0` still rejects the catastrophic `0`/negative/NaN). A `RuntimeParameters` field (`getRuntimeParameters`/`setRuntimeParameters`), uploaded to the device via the same stream-ordered path as `volume`/`feedback`. **Per-session** (not preset-persisted). Non-finite → `400`.

`amplitude_gate_enabled` (optional, bool/0-1, dev-538e): toggles ONLY the `|displacement| > amplitude_limit` branch of the crash-guard. **Default `true`** (ON). When `false`, the amplitude branch is bypassed — but the **`isnan` safety check remains active unconditionally** (disabling the amplitude gate does NOT re-expose the NaN→ASIO crash; the kernel still self-heals on NaN). Note the tradeoff: with the amplitude gate OFF a geometric FDTD runaway can blow displacement to `inf` (which `isnan` does not catch) and a cycle of `inf` reaches the output before a NaN eventually forms — this is exactly the escape the amplitude gate prevents when ON. Accepts a JSON boolean or `0`/`1`. A `RuntimeParameters` field (`amplitude_gate_enabled`, int 0/1). Per-session.

**Init-time seeding (P1 single-owner contract):** the engine boots in NEW-formula mode. `pianoid.init_pianoid` seeds `volume_center = max_volume**(64/127) × output_scale` (positive — engages the new formula; `output_scale` = the active preset's per-preset Layer-B scale, dev-volcal) with `volume_range = 10`; `pianoid.switch_preset` re-derives the same bare seed × the TARGET preset's `output_scale` (its stored value — a live switch never re-renders it, see [Layer B output level](#layer-b-output-level-output_scale)) and keeps the current `volume_range` (global). This is required because the UI ToolBar `VolumeSlider` always sends a positive center once touched; without seeding, startup state is `center=0` (legacy) and the user perceives "much higher sensitivity" until they round-trip the slider. The seed value is anchored at level=64 so coefficient at level=64 is unchanged from the legacy formula — only the slope across other levels changes (legacy: `max_volume^(63/127)` ratio between levels 64 and 127; seeded: `range = 10`). The frontend mirrors this in `usePreset.loadPreset` (defense in depth — explicit `set_runtime_parameters` POST after preset load). Regression test: `tests/integration/test_volume_sensitivity_reset.py::test_initial_runtime_params_seeded_for_new_formula`. The legacy frontend `localStorage` key `volumeRange` is no longer read.

Response `200`:
```json
{"message": "OK", "updated": {"volume": 80, "feedback": 64}}
```

#### Layer B output level (`output_scale`)

Per-preset linear scale (`model_parameters.output_scale` + `output_scale_calibrated`, persisted on save) that lands
the preset's p60 v127 at the preset's **calibration target** at slider 64 (default −2 dBFS; a chord-headroom target
when the preset has one, see below): `engine volume_center = bare volume_center × output_scale`. Owner:
`pianoid_middleware/output_level.py` (dev-0da4).

| Rule | Behaviour |
|---|---|
| when it is derived | `calibrate_output_scale()` — offline p60 v127 render, ONLY when `output_scale_calibrated` is false. Runs at `init_pianoid` (engine not yet live) and is attempted at `switch_preset`; on demand via `POST /recalibrate_output_level` |
| impulse reference (dev-5852) | the calibration is referenced to the p60 v127 hammer impulse `J = c·m60·speed(127)`, persisted as `model_parameters.output_scale_reference_impulse`: p60 lands at −2 dBFS × `J_now/J_ref`. A re-calibration therefore removes only the non-impulse (shape / physics) part of a level change and can never undo a mass / speed / `c` edit. Genesis (no reference) or `absolute: true` → J_ref := J_now (exactly −2 dBFS). Calibrated presets saved before dev-5852 adopt their current J on load |
| never on a live engine | the measurement refuses (before touching the engine) while the C++ main loop flag `shouldContinue()` or the playback thread `online_engine.isRunning()` is set — a library switch with the engine running never renders (volume-equalization review I-7: the render page-faults / clobbers live string state) |
| a refused / failed / silent render | carries no level information → **nothing is written**: the stored `output_scale` and the (stale) flag are kept, a `[volcal B] WARNING … NOT re-calibrated` line is logged and `/health.output_scale.warning` is set. (Before dev-0da4 a refused render read as peak 0 → `output_scale = 1.0` + calibrated → the engine went ~230 dB quiet, bug B1.) |
| edit policy (user decisions 2026-10-06/07, `output_level.classify_edit`) | **shape** edits — excitation curves (`gauss`/`excitation`/`string_excitation_curves`, temporal) and hammer geometry (`hammer`, `hammer_width`/`_position`/`_sharpness`, spatial) — change the timbre and must keep the level: they clear the flag; the next legal calibration compensates them. They are the ONLY recalibration triggers. **Level** edits — `hammer_mass`, `hammer_speeds`, `excitation_impulse_calibration` (`/excitation_energy`, the equalizer) — are by-design loudness: the flag is NOT cleared. **Physics** edits (dev-e772) — `string`/`physics` non-hammer fields (rho, length, tension, damping, …), `mode`, `string_gain` — change the level by physics and are kept as heard (WYSIWYG): NOT cleared (live: tension ×1.02 → +0.59 dB kept). `sound_channel` / `string_sound_channel` have no level class (like `feedin`/`feedback`/masks): `sound_channel` is inert in strings mode (measured: ×50 on p60 → −1.999 vs −2.000 dBFS) and `string_sound_channel` has no FE writer. A hammer POST that changes nothing is not an edit. Clearing the flag never renders; the stored value stays in use until a calibration runs |
| load settings (review I-5/R5, dev-e772) | a calibration is valid only at the load settings it was measured at, persisted as `model_parameters.output_scale_load_settings = {array_size, sound_derivative_order, listen_to_modes, sr, mode_iteration, string_iteration}`. Measured p60 bare level vs Belarus_8band_196modes at d2/384/si4/cyc64/sr48/strings: d1 **+18.6 dB**, array 512 **−3.0 dB**, cycle_iterations 128 **+15.9 dB**, string_iterations 8 +0.25 dB, sample_rate 44 +0.15 dB, listen_to_modes 1 **+35.9 dB** — all six are in the key. On mismatch (or no recorded settings = legacy preset) the next LEGAL calibration re-measures with the impulse reference KEPT, so the preset keeps its level relative to the reference (a d1→d2 switch no longer drops it 19 dB); `init_pianoid` (full load) and the in-place structural re-init (`sample_rate`/`string_iterations`/`cycle_iterations`, engine stopped → `output_level.ensure_calibrated`, volume_center re-layered) both do it. A live library switch cannot render: the stored scale is kept, `/health.output_scale.settings_match=false` + `warning`. **Legacy presets** (calibrated before dev-e772) are re-measured on their first full load — e.g. Belarus_8band_196modes' stored 4.555e11 was measured in modes mode (= the listen_to_modes 1 scale): at d2/384 strings it played p60 at −37.95 dBFS and now lands at −2.00 dBFS (+35.95 dB, reported as `/health.output_scale.last_calibration.change_db`). Not saved → re-measured (~2–3 s) on every load until the preset is saved |
| calibration target (dev-0ccf) | `model_parameters.output_scale_target_dbfs` (persisted, `null` = engine default **−2 dBFS** = `Pianoid.OUTPUT_SCALE_TARGET_PEAK`): the dBFS p60 v127 lands at @ slider 64 (× `J_now/J_ref`). EVERY calibration uses it — load-settings re-measure, shape-edit re-calibration, `absolute: true` — so a chord-safe preset never snaps back to −2 dBFS. Set by the **chord-headroom calibration** (`output_headroom.py`, `POST /recalibrate_output_level {"chord_peak_dbfs": -6}`): offline renders of p60 and 16 canonical loud two-hand chords (6–10 notes, v127, struck together, `output_headroom.CANONICAL_CHORDS`), `target = chord_peak_dbfs − max_chord(20·log10(chord_peak/p60_peak))` (≥ 0 dB), then an absolute calibration (J_ref := J_now). Measured (2026-10-07): loudest chord vs p60 = **+14.06 dB** Belarus_8band_196modes (`dim7_2hand_10`, d2/384/si4) → target **−20.06 dBFS**; **+22.59 dB** F15_Elyashev_array512 (`cluster_treble_10`, d1/512/si16) → **−28.59 dBFS**. Live @ slider 64 (REST chords, 3 runs): Belarus worst −6.2 dBFS, F15 −11.4 dBFS, no clipping / limiting (REST onset jitter of a few ms changes a chord's peak by −3…+1.4 dB vs the simultaneous offline onset; pedalled 3× re-strikes measured +0.2…+2.0 dB) — the −6 dBFS margin keeps all of it below the limiter knee (0.8 FS = −1.94 dBFS). `/health.output_scale.target_dbfs` + `target_source` (`preset`/`default`) report it |
| measurement conditions (dev-fcef, 2026-10-08) | the calibrated peak is the **max over ALL output channels** (`getRecordedAudio` is all channels interleaved), so the LOUDEST channel lands at the target. Measured live per channel (`/health` latched peaks, bare `volume_center` 1.0, slider 64, 3 runs, no clipping): F15_Elyashev_array512 @ 512/d1/si16 p60 ch0..3 −51.9/−34.4/−45.1/**−28.59** dBFS (ch3 = target exactly, loudest chord −9.1), Belarus_8band_196modes @ 384/d2/si4 −20.5/−24.3/**−20.06**/−27.5 (ch2 = target, loudest chord −7.2) — offline projection and live output agree to 0.00 dB. The render runs at the preset's **stored** deck feedback (`mp.deck_feedback_coefficient`) and restores the session value after: the frontend feedback slider (effective = stored × multiplier, global) changes the level (F15 ×2.0 → −5.27 dB) and before dev-fcef a calibration taken with the slider off-neutral baked it into `output_scale` (+5.27 dB → p60 −23.3 dBFS at the preset feedback). **Not calibrated (global session layers, by design):** the init volume (`exp((volume−100)/8)`: volume **127 = +29.31 dB** — F15 ch3 then plays p60 at +0.7 dBFS and clips, the dev-12a5 observation), the slider level and the feedback slider |
| level-neutral rescales | `compensate_output_scale(f)` — `output_scale × f`, the engine center × f and the impulse reference ÷ f together (exact, no render; dev-168c mass rescale) |

##### `POST /recalibrate_output_level` (dev-5852)

Explicit "re-calibrate level". Body (optional): `{"absolute": false, "chord_peak_dbfs": null}`. The realtime engine is stopped
around the offline p60 v127 render and restarted (the chart-render stop → render → restart pattern —
never a render on a live engine; measured live 2.3 s, engine restarted, no fault), and the live
`volume_center` is re-layered so the bare volume setting is kept. Default: level-preserving (impulse
reference kept → shape/physics changes compensated, mass/speed/`c` edits kept). `absolute: true`:
p60 v127 → exactly the preset's target (default −2 dBFS) @ slider 64 and the reference is reset.
`chord_peak_dbfs` (dev-0ccf, `[-40, -1]`, else `400`): chord-headroom calibration — measures the canonical
chords, stores `output_scale_target_dbfs` so the loudest peaks at `chord_peak_dbfs` @ slider 64, absolute
calibration (measured live 9.5 s Belarus / 18 s F15 incl. stop/restart); the response adds `headroom`
(`chords` {name: {pitches, db_vs_p60}}, `worst`, `worst_db`, `target_dbfs`, `previous_target_dbfs`,
`committed`). Persist with `/save_preset` (or promote). Note: a render taken right after the engine ran
measures p60 ~0.25 dB lower than a fresh-load render (Belarus 5.80e-5 vs 5.97e-5), so a scale committed
here plays ~0.25 dB louder after a restart; the working presets were re-cached from a fresh full load.
Response `200`: the `/health` `output_scale` block + `previous_value`, `engine_was_running`, `headroom`;
`409` when the render was refused / failed / silent (nothing written, `warning` says why).

When amplitude-gate fields are sent, the `updated` dict echoes the applied (clamped) values, e.g.
`{"updated": {"amplitude_limit": 5000.0, "amplitude_gate_enabled": 0}}`.

Response `400`: missing parameters, invalid range, or pianoid not initialized.
Response `500`: internal set failure.

**Symmetric WS event:** the `set_runtime_parameters` WebSocket event carries the same payload
(including `amplitude_limit` / `amplitude_gate_enabled`) through the shared `_apply_runtime_parameters`
handler and returns the same `{ok, updated}` ack shape.

---

## Playback Endpoints

### `POST /play`

Triggers a note-on or note-off event. Routes to the unified EventQueue system (v3.0+) if `realtime_buffer` is available.

Request body (unified format):
```json
{
  "pitch": 60,
  "velocity": 100,
  "command": 144,
  "delay_ms": 0.0,
  "source": "midi"
}
```

`command` values:
- `144` + `velocity > 0` — NOTE_ON
- `128` or `144` + `velocity == 0` — NOTE_OFF
- `176`/`177`/`178` + `pitch == 64` — SUSTAIN pedal

`source` field (optional, dev-bv01 2026-05-03):
- `"midi"` — caller is a MIDI source (frontend WebMIDI hardware via `useMidi.handleMIDIMessage`, future MIDI-router integrations). Backend applies `Pianoid.apply_fix_velocity` to NOTE_ON velocity per the Fix-MIDI velocity clamp contract above.
- omitted / any other value — non-MIDI source (virtual piano click, space-bar, Excitation editor, calibration). Velocity passes through unchanged regardless of Fix-MIDI state.

**Cross-transport deduplication (dev-md01 2026-05-03).** The handler caches
the last `(mapped_d1, command)` it scheduled in a single shared module-global
key (`_last_play_cmd_key` in `backendServer.py`) protected by a thread lock.
A second call with the same `(mapped_d1, command)` is silently dropped (200
OK response, but no event is enqueued onto `RealTimeEventBuffer`). The dedup
state is shared between REST `/play` and WS `play` and is NOT keyed by
client SID, transport, source flag, or velocity — so a duplicate that
crosses transports (e.g. `usePreset.playNote` falling back from WS to REST
during a transient WS reconnect) or comes from a different WS client is
caught the same as a same-transport duplicate. Distinct events
(`NOTE_ON 60` then `NOTE_OFF 60`, or `NOTE_ON 60` then `NOTE_ON 61`) pass
through normally because their `(mapped_d1, command)` keys differ. Pre-fix
the dedup state was split into `_ws_last_command` (per-SID, WS only) +
`last_command` (module-global, REST only) which left a gap on cross-transport
and cross-SID duplicates — the user-visible "MIDI notes sound twice"
regression. Regression test:
`tests/system/test_play_dedup.py` (8 cases — same-transport, cross-transport
both directions, cross-SID, distinct-events sanity).

Request body (legacy format):
```json
{
  "pitch": 60,
  "command": 144,
  "velocity": 100
}
```

Response `200`:
```json
{"Message": "OK", "mode": "unified"}
```

Response `417` if pianoid is in exception state.

**Coexistence with the MIDI listener (dev-midi-play 2026-05-15).** `POST /play`
and WS `play` schedule notes **regardless of whether the unified MIDI listener
is running** (`listen_to_midi=1` / `POST /midi/start`). UI-originated play —
on-screen virtual piano, space-bar hotkey, Excitation editor, calibration —
and inbound hardware MIDI coexist: both routes converge on the thread-safe
`Pianoid.schedule_event(...)` → `RealTimeEventBuffer`, which serialises
concurrent producers (see [MIDI System](MIDI_SYSTEM.md)). There is no
exclusive-ownership lock between the two paths.

A legacy `if pianoid.listen` short-circuit used to drop every `/play` (and WS
`play`) request while the listener thread was alive — returning `200 OK` but
enqueueing nothing. It was a relic of the pre-unified `MidiListener` design
where the listener owned the engine exclusively; the W4 Phase 3 frontend MIDI
panel (which lets the user start the listener at runtime) exposed it as a
regression — the on-screen keyboard and space-bar fell silent whenever MIDI
listening was on. The gate was removed (CODE_QUALITY.md **P1**: the play
path's admission authority is the lifecycle state `PLAYBACK_ACTIVE`, enforced
inside `schedule_event` — not the unrelated listener flag). Regression test:
`tests/unit/test_play_listen_gate_regression.py`.

---

### `POST /play_mode/<mode_no>`

Triggers immediate playback of a specific resonance mode.

`mode_no`: integer mode index

Response `200`:
```json
{"Message": "OK"}
```

Response `416` if `mode_no` is not a valid integer.

> **Debug-build required.** The endpoint returns the mode-state record
> (`SOUND_REC_MODE_STATE`, record 1) which is populated only in debug builds
> (`PIANOID_BUILD_VARIANT=debug`); release builds return an empty array
> silently. See [DEBUG_DATA: Sound Records Buffer](../pianoid-cuda/DEBUG_DATA.md#sound-records-buffer).

---

### `POST /play_keyboard`

Plays the full keyboard as a NOTE_ON/NOTE_OFF sweep in either online (live driver) or offline (rendered WAV) mode. Online mode can optionally record the microphone while playing so room acoustics can be captured.

Request body:
```json
{
  "mode": "online",
  "speed_ms_per_note": 100,
  "velocity": 63,
  "capture_mic": false,
  "tail_ms": 2000,
  "pitches": null,
  "channel": 0
}
```

- `mode`: `"online"` (default) schedules events through the live audio driver and returns immediately. `"offline"` stops the online engine, runs `runOfflinePlayback`, writes a peak-normalized 16-bit PCM synth WAV to `/tmp/keyboard_offline_<timestamp>.wav`, then restarts the engine.
- `speed_ms_per_note`: NOTE_ON to NOTE_OFF duration per key (also the per-step advance). Clamped to 10–2000 ms.
- `velocity`: MIDI velocity 1–127, default 63 (mf).
- `pitches`: optional explicit list; omit for all available pitches.
- `channel` (offline only, default `0` = output pitch 128): the output channel written to the mono WAV. `400` outside `0..num_channels-1`. The render's buffer holds, per 64-sample cycle, one block per output channel (`[ch0 × 64, ch1 × 64, …]`, [TESTING.md](../../development/TESTING.md)); the route de-interleaves it with `PianoidResult.load_offline_channels`. Before dev-obuf1 the whole buffer went into the WAV as mono: `num_channels` × too long (7 channels: 175 s for 25 s rendered, report 8761b5c4), the level repeating every 7 blocks, a jump at every block boundary and a 750 Hz (= 48000 / 64) line.
- `capture_mic` (online only, default `false`): when `true`, the server calls `startMicCapture` before scheduling events, sleeps synchronously for `speed_ms_per_note * num_pitches + tail_ms`, then calls `stopMicCapture` and writes an un-normalized 16-bit PCM mic WAV to `/tmp/keyboard_mic_<timestamp>.wav`. Requires an active audio driver with a selected input device — set via `POST /set_mic_device` if needed.
- `tail_ms` (online, `capture_mic` only): extra capture time after the last NOTE_OFF to catch decay. Clamped to 0–10000 ms, default 2000.

Online response (no mic): scheduled event count + nominal duration, returns immediately — `{status, mode, scheduled_note_on, total_pitches, speed_ms_per_note, duration_ms, schedule_epoch_ms}`. `schedule_epoch_ms` (dev-2cce) = the backend wall-clock time (`time.time()·1000`) that `delay_ms = 0` refers to: note *i* is scheduled at `schedule_epoch_ms + i·speed_ms_per_note`. The frontend Play All highlight anchors to it (same machine, same clock).
Online response (with mic): adds `mic_wav_path`, `mic_sample_rate`, `mic_samples`, `mic_peak`, `mic_rms`, `mic_nonzero_fraction`. Blocks until capture finishes.
Offline response: `wav_path`, `audio_data`, `audio_samples` (of the one WAV channel = `cycles_rendered` × 64), `cycles_rendered`, `channel`, `num_channels`, `peak`, `rms`, `peak_normalized_scale`. The WAV is peak-normalised whatever the level (the pre-volume kernel output can be ~1e-13; an absolute 1e-9 floor used to write an all-zero WAV); only true silence keeps scale 1.

- `audio_data`: the rendered WAV as a **list of one base64 string** — same shape as `POST /get_chart_test` (`["<base64 WAV string>"]`). It is the base64 of the bytes just written to `wav_path` (a complete RIFF/16-bit-PCM file), so the browser can decode and play it directly (`atob` → `Uint8Array` → `Blob({type:'audio/wav'})`) without reaching the server-side `wav_path`. The frontend "Play All" offline sweep (`PianoidTuner.js` `startSweep`) consumes `audio_data[0]`. `wav_path` is retained for server-side debugging.

Response `400` for invalid params or empty pitch list. Response `417` if pianoid is in exception state.

---

### `POST /midi_playback`

Controls online MIDI file playback.

Request body:
```json
{
  "action": "start",
  "midi_file": "elise.mid",
  "start_delay_ms": 500
}
```

`action` values: `"start"`, `"stop"`, `"status"`

`midi_file` choices: `"elise.mid"`, `"mond_1.mid"`

Response `200`:
```json
{
  "status": "success",
  "midi_file": "elise.mid",
  "events_scheduled": 1234,
  "duration_ms": 30000
}
```

Response `400` for invalid action or pianoid not initialized.

### MIDI player — `/midi_player/*` (dev-6f0c)

Backend-timed MIDI-file player ([MIDI_SYSTEM.md → MIDI player](MIDI_SYSTEM.md#midi-player-dev-6f0c)). Every POST answers the full **status**; the same status is pushed as Socket.IO `midi_player_state` on each change and every 250 ms while playing. Errors: `400 {error, status}` (no file loaded, file not found / not MIDI / > 16 MB, engine not running, bad body).

| Method + path | Body | Effect |
|---|---|---|
| `GET /midi_player/status` | — | current status |
| `GET /midi_player/library` | — | `{midi_dir, bundled_dir, files: [{name, path, source: "midi"\|"bundled", folder, bytes}]}` (`<PianoidInstall>/midi` or `$PIANOID_MIDI_DIR`, recursive, + `MIDI_records/`) |
| `POST /midi_player/load` | `{"path": "<absolute path>"}` or multipart field `file` | stop, parse, load (mutes cleared; speed / loop / transpose / velocity kept) |
| `POST /midi_player/transport` | `{"action": "play" \| "pause" \| "stop"}` | play needs a running engine; pause/stop = all notes off; stop rewinds to 0 |
| `POST /midi_player/seek` | `{"position_ms": float}` | while playing: all notes off, resume there (pedal state chased) |
| `POST /midi_player/options` | any of `speed` (0.25-4), `loop` (bool), `transpose` (−24..24), `velocity_scale` (0.1-2) | values clamped to the ranges |
| `POST /midi_player/mute` | `{"track": i}` or `{"channel": 0-15}` + `"muted": bool` | muting releases that source's held notes |

Status: `{loaded, song: {name, path ("" for an upload), duration_ms, events, initial_bpm, midi_type, tracks: [{index, name, channels, notes, pedal_events}], channels: [{channel, notes}]}, state: "stopped"|"playing"|"paused", position_ms, duration_ms, speed, loop, transpose, velocity_scale, muted_tracks, muted_channels, loops, skipped_notes, error, version}`. Write class: `action` (status/library `read_only`).
Response `404` if MIDI file not found.
Response `500` for unexpected errors.

---

### `GET /playback_stats`

Returns EventQueue buffer and engine statistics.

Response `200`:
```json
{
  "unified_mode": true,
  "state": "PLAYBACK_ACTIVE",
  "unified": {
    "buffer": {
      "total_events_pushed": 42,
      "total_events_drained": 42,
      "peak_buffer_size": 3,
      "avg_insert_latency_us": 12.5,
      "avg_drain_latency_us": 8.1,
      "current_size": 0
    },
    "engine": {
      "total_events_processed": 42,
      "realtime_events": 40,
      "scheduled_events": 2,
      "avg_event_latency_ms": 1.2,
      "calibration_count": 1
    }
  }
}
```

---

## MIDI Endpoints

### `GET /midi/ports`

Returns the list of available rtmidi input ports as observed at the moment of the call. Stateless — works even before `/load_preset` has initialized a `pianoid` instance, because the implementation opens a transient `rtmidi.MidiIn()` to read the port table.

Use this to populate a port-picker UI before posting `listen_to_midi=1` to `/load_preset` or before calling `POST /midi/select_port`.

Response `200`:
```json
{
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"],
  "active_port": 0,
  "listening": true,
  "port_state": {"mode": "auto", "port": 0, "name": "VMini 0", "detecting": false}
}
```

- `ports`: ordered list of rtmidi port names; the array index is the canonical port id used by `midi_port` (in `/load_preset`) and by `POST /midi/select_port`.
- `port_state` (dev-392a): how the listener chose its port: `mode` `forced` (explicit request port) / `manual` (the user's saved port) / `auto` (auto-detect; `detecting: true` while it waits, `port` null), or `null` before the listener started.
- `active_port`: the port currently held open by the unified MIDI listener, or `null` when the listener is not running.
- `listening`: `true` when the unified listener thread is alive (i.e. `/load_preset` was called with `listen_to_midi=1`).

Response `500`:
```json
{"error": "MidiPortsFailed", "message": "<rtmidi exception text>"}
```

---

### `POST /midi/select_port`

Switches the running unified MIDI listener to a different rtmidi input port without stopping or restarting the listener thread. The listener loop closes the previously-opened port and opens the new one at the start of its next iteration (typically within ~10 ms), preserving cycle-aligned dispatch for any in-flight `schedule_event` calls.

Request body:
```json
{"port": 1}
```

- `port` (int, required): 0-based rtmidi input-port index from `GET /midi/ports`, or `"auto"` (dev-392a): drop the saved port and auto-detect again now.

The listener **persists** a switch once it succeeded (dev-392a) as `input_port` in `GET /midi/input`: the port NAME without the rtmidi index suffix (`"MIDIIN2 (VMini)"`), or `null` for `"auto"`. Every later listener start (preset load, `/midi/start`, backend restart) opens that port again. The new port is opened before the old one is released; a failed open (port held elsewhere) keeps the old port and persists nothing, and a refused request (409) persists nothing. Route owner: `midi_input_routes.py` (the `/midi/ports`, `/midi/select_port`, `/midi/start`, `/midi/stop` routes moved there from `backendServer.py`, dev-392a).

Response `200`:
```json
{"port": 1, "name": "MIDIIN2 (VMini) 1"}
```
or `{"port": "auto"}`.

Response `400` — bad request body:
```json
{"error": "BadRequest", "message": "Missing or non-integer \"port\" field."}
```

Response `400` — out of range:
```json
{
  "error": "PortOutOfRange",
  "message": "Port 9 not in range 0..1",
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response `400` — no MIDI hardware:
```json
{"error": "NoMidiPorts", "message": "No MIDI input ports available"}
```

Response `409` — listener not running:
```json
{
  "error": "ListenerNotRunning",
  "message": "Unified MIDI listener is not running. Pass listen_to_midi=1 to /load_preset."
}
```

---

### `POST /midi/start`

Start the unified MIDI listener at runtime without re-issuing `/load_preset` (W3 Phase 2). Idempotent — if the listener is already running, returns the current state without restarting (no double-open of the rtmidi port).

Request body (all fields optional):
```json
{"port": 0}
```

- `port` (int, optional): 0-based rtmidi input-port index to force for this start. Omitted (what the Tunner sends since dev-392a) = the user's saved input port, else auto-detect. Use `GET /midi/ports` to enumerate available ports. Out-of-range ports are rejected with 400.

Response 200 — listener now running (or already was):
```json
{
  "listening": true,
  "active_port": 0,
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 400 — no MIDI hardware:
```json
{"error": "NoMidiPorts", "message": "No MIDI input ports available"}
```

Response 400 — port out of range:
```json
{
  "error": "PortOutOfRange",
  "message": "Port 5 not in range 0..1",
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 500 — listener start failed (rtmidi exception, thread creation failure, etc.):
```json
{"error": "MidiStartFailed", "message": "<exception text>"}
```

Response 400 — port acquisition failed asynchronously (W4 Phase 3 fix D):
```json
{
  "error": "PortOpenFailed",
  "message": "Failed to acquire MIDI port; another process may hold it.",
  "port": 0
}
```

The listener thread opens the rtmidi port inside `MIDI_listener_unified` (async, not in the request handler). If the port is held by another process (a Werkzeug debug-reloader sibling, a stale backend, or any other MIDI consumer), rtmidi raises and the thread bails. The handler sleeps 50 ms then re-reads `_midi_active_port` — if still `None` and `self.listen` has flipped back to False (fix C), the open failed and 400 is returned instead of falsely-true 200.

---

### `POST /midi/stop`

Stop the unified MIDI listener at runtime without tearing down the synthesis engine (W3 Phase 2). Idempotent — if no listener is running, returns the current state without raising. Internally calls `Pianoid.stop_midi_listener()`, which sets `self.listen = False` and joins the listener thread with a 1 s timeout; the rtmidi port is released cleanly on loop exit.

Request body: empty `{}` accepted.

Response 200 — listener stopped (or already was):
```json
{
  "listening": false,
  "active_port": null,
  "ports": ["VMini 0", "MIDIIN2 (VMini) 1"]
}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 500 — stop failed:
```json
{"error": "MidiStopFailed", "message": "<exception text>"}
```

---

### `GET /midi/broadcast`

Return the current state of the W4 Phase 3 broadcast gate. The gate controls whether the unified MIDI listener's per-event emit callback forwards `midi_note_event` Socket.IO messages to clients. Default is `true` on every fresh `Pianoid` init (matches the W3 Phase 2 default). Independent of the listener-running state — the gate is still readable when the listener is stopped (in which case no events flow anyway).

Response 200:
```json
{"enabled": true}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

---

### `POST /midi/broadcast`

Toggle the W4 Phase 3 broadcast gate. The toggle takes effect on the very next inbound MIDI byte — the listener thread is not stopped, restarted, or otherwise touched. Useful for suppressing the per-event Socket.IO stream during calibration runs, heavy-load synthesis tests, or any other workload where the `midi_note_event` chatter is undesirable.

Request body:
```json
{"enabled": false}
```

- `enabled` (bool, required): truthy enables broadcast (default on every fresh init); falsy suppresses the stream.

Response 200:
```json
{"enabled": false}
```

Response 400 — preset not loaded:
```json
{"error": "PianoidNotInitialized"}
```

Response 400 — missing field:
```json
{"error": "BadRequest", "message": "Missing \"enabled\" field."}
```

---

### Socket.IO `midi_note_event` (server -> client)

Pushed by the unified MIDI listener thread for every observed inbound MIDI byte that survives the two filters in `emit_midi_note_event` (W4 Phase 3). Wired in `backendServer.py` via the helper that is constructor-injected into the `Pianoid` instance per W1 Phase 0 decision A2.

Two filters apply on every invocation:

1. **Note-only filter.** Only NOTE_OFF (status `128`-`143`, channels 0-15) and NOTE_ON (status `144`-`159`, channels 0-15) are forwarded. CC (including sustain CC#64), program-change, pitch-wheel, aftertouch, and sysex are silently dropped — they have no place on a "last note pressed" indicator stream. (Sustain still drives synthesis via `schedule_event(...)`; the drop is on the emit path only.)
2. **Broadcast on/off gate.** When `GET /midi/broadcast` reports `{"enabled": false}`, no emit happens. The gate is per-event (read live from the running `pianoid` instance), so toggling via `POST /midi/broadcast` takes effect on the very next inbound byte.

Payload (when both filters pass):
```json
{"command": 144, "pitch": 60, "velocity": 100}
```

- `command`: raw MIDI status byte in `128`..`159` (NOTE_OFF / NOTE_ON, channels 0-15).
- `pitch`: MIDI data1 (pitch).
- `velocity`: MIDI data2 (velocity; `0` on NOTE_ON encodes the running-status NOTE_OFF convention used by some hardware).

Start the listener with `listen_to_midi=1` on `/load_preset` (W3 Phase 2 default) or `POST /midi/start` (runtime). Stop the chatter without stopping synthesis via `POST /midi/broadcast {"enabled": false}` (W4 Phase 3).

---

### `GET /midi/input`

(dev-ped1) The live MIDI input settings and the sustain state. Owner: `midi_input.MidiInputHub` (process-wide, survives preset loads; routes in `midi_input_routes.py`). Works before a preset is loaded. Registry: `midi.input_settings`.

Response 200:
```json
{"sustain_cc": 64, "sustain_channel": null, "polarity": "normal", "show_realtime": false, "monitor_all_ports": true,
 "input_port": "MIDIIN2 (AMC-10)", "port_state": {"mode": "manual", "port": 2, "name": "MIDIIN2 (AMC-10) 2", "detecting": false},
 "sustain_down": false, "sustain_value": 0, "counts": {"note_on": 12, "note_off": 12, "control_change": 3}}
```

- `sustain_cc`: the CC number treated as the sustain pedal (default 64). The default pedal (64, any channel) reaches the engine unchanged (switch at 64). A remapped one (another CC, or a `sustain_channel`) reaches it as CC64 `127` / `0` (hysteresis after the polarity: down at >= 74, up at <= 54). Any other CC64 is dropped.
- `sustain_channel` (dev-392a): the pedal's MIDI channel 1-16, or `null` = any channel (default). Set it when several pedals send the same CC on different channels (the AMC-10: CC 0 on channels 1-3, sustain = channel 2).
- `polarity`: `normal` (a high value = down) or `inverted` (the pedal sends 0 when pressed: the value is mirrored, `127 - v`, before the switch: the engine's at 64 for the default pedal, the hysteresis for a remapped one).
- `show_realtime`: clock / start / stop / active sensing / reset (`0xF8`-`0xFF`) are pushed to the monitor only when true.
- `monitor_all_ports`: the monitor also reads every other input port (monitor only; the engine plays from the selected port alone). Applied at the next listener start or port switch.
- `input_port` (dev-392a): the input port the user picked, by name (rtmidi index suffix stripped), or `null` = auto-detect (default). Written by `POST /midi/select_port` (or here); used at every listener start.
- `port_state` (dev-392a): see `GET /midi/ports`.
- `sustain_down` / `sustain_value`: the pedal state the engine was last sent / the last raw value of the sustain CC (`null` before the first one).
- `counts`: messages per type on the played and the tapped ports since the backend started.

### `POST /midi/input`

Any subset of `{"sustain_cc": 0-127, "sustain_channel": null | 1-16, "polarity": "normal" | "inverted", "show_realtime": bool, "monitor_all_ports": bool, "input_port": null | "<port name>"}` (`input_port` applies at the next listener start; to switch now use `POST /midi/select_port`). Validated, applied to the next message, persisted to `$PIANOID_MIDI_SETTINGS` or `<PianoidInstall>/midi/midi_input_settings.json` (git-ignored). Response 200 = the `GET` body; 400 `{"error": "BadRequest", "message": "polarity must be one of normal, inverted"}` on a bad or unknown field or an empty body. Registry: `midi.set_input_settings`. Classified `session` (`session_changed{domain: 'midi'}`).

### Socket.IO `midi_input_state` (server -> client)

(dev-392a) The `GET /midi/input` body, pushed whenever the listener's port changes: started on a forced / saved port, auto-detect waiting, port detected, switched. Not gated by the broadcast switch (a few events per session).

### Socket.IO `midi_message` (server -> client)

(dev-ped1) One record for **every** message the listener receives — notes, CC, program change, pitch bend, aftertouch, sysex (summary), and clock / active sensing when `show_realtime` — from the played port and, with `monitor_all_ports`, the other input ports. Pushed after the engine dispatch (never delays a note); gated by the same broadcast switch as `midi_note_event`. The engine never receives system messages (`0xF0`-`0xFF`).

```json
{"raw": "B2 00 7F", "bytes": 3, "status": 178, "channel": 3, "type": "control_change",
 "number": 0, "value": 127, "name": "Bank Select", "label": "CC 0 Bank Select = 127",
 "port": 2, "port_name": "MIDIIN2 (AMC-10) 2", "playing": true, "time": 1761140000.123,
 "delta": 0.0123, "sustain": false, "sustain_down": false}
```

- `type`: `note_on`, `note_off` (also NOTE_ON velocity 0), `poly_aftertouch`, `control_change`, `program_change`, `channel_aftertouch`, `pitch_bend`, `sysex`, `clock`, `start`, `continue`, `stop`, `active_sensing`, `reset`, `mtc_quarter_frame`, `song_position`, `song_select`, `tune_request`.
- `channel`: 1-16 (null for system messages). `number`: note or CC number. `value`: velocity / CC value / program / pressure / pitch bend (-8192..8191, 0 = centre).
- `raw`: the bytes as received, hex (sysex: first 16 bytes + `...`). `playing`: false = a tapped port (monitor only).
- `sustain`: this message is the configured sustain CC; `sustain_down`: the engine's pedal state after it.

---

### `GET /get_available_notes`

Returns a list of MIDI pitch numbers currently loaded in the preset.

Response `200`:
```json
[21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 88]
```

---

## Chart Endpoints

### `GET /graph_names`

Returns all registered chart types and action types from the `ChartTypeRegistry`.

Response `200`:
```json
{
  "graphs": [
    {
      "name": "sound",
      "label": "Sound Analysis",
      "parameters": [
        {"name": "length", "type": "number", "label": "Length", "defaultValue": 10000},
        {"name": "channel", "type": "number", "label": "Channel Number", "defaultValue": 0}
      ]
    }
  ],
  "actions": [
    {
      "name": "filter",
      "label": "Filter",
      "parameters": [...]
    }
  ],
  "message": "OK"
}
```

---

### `POST /get_chart_test`

Renders a chart by delegating to `ChartGenerator` (for chart types) or `ActionPerformer` (for action types).

Request body: chart type name plus any chart-specific parameters:
```json
{
  "chartType": "sound",
  "length": 48000,
  "channel": 0
}
```

If `chartType` resolves to an action type in the registry, the action is executed and the response has status `499`.
(Measured in code, dev-947d: the route looks a name up as `chart` and `dynamic_chart` only, so an action name such as
`auto_tune` does not resolve and answers `416`; actions run through `POST /start_test`.) Every chart function that renders
offline stops the realtime engine first and restarts it on every path, a failed render included (dev-947d:
`note_playback` and offline `sound_test` used to skip the restart on a render error).

Response `200`:
```json
{
  "data": [[0.1, 0.2, ...]],
  "general_header": "Sound record",
  "text_fields": {
    "Sound obtained": "Length 1000.00 ms, channels 2",
    "Sound displayed": "Length 500.00 ms, channel 0"
  },
  "chart_headers": [""],
  "audio_data": ["<base64 WAV string>"]
}
```

Response `416` on internal error (returns traceback string).
Response `499` when chart type is actually an action type.

---

### `POST /start_test`

Executes a registered action type by delegating to `ActionPerformer`.

Request body:
```json
{
  "action_type": "filter",
  "toggle": true,
  "file": "Bluthner.fir"
}
```

Response `200`:
```json
{"Message": "OK"}
```

Response `416` on internal error.

---

### `POST /capture`

Forces extraction of the current simulation result buffer. Useful before requesting a chart when `debug_mode` is enabled.

Response `200`:
```json
{"Message": "OK"}
```

---
### `POST /bug_report`

Diagnostic bug-report **collector** (dev-bugauto, 2026-07-11). The frontend
AUTO-fires a bug report on an internal system fault (backend crash/exception,
unresponsive endpoint, prohibited/clamped values, uncaught FE error) and POSTs
the report JSON here so it lands on disk in a folder the dev/orchestrator watches
— no user download, no click. The **manual** 🐞 dialog files its report here too
(dev-fe18, 2026-10-18; `trigger: {auto: false}` → the `manual` tag) and downloads
client-side only when this endpoint is unreachable. See
[BUG_REPORT_TOOL.md → Auto-Fire](../pianoid-tunner/BUG_REPORT_TOOL.md#auto-fire-on-internal-system-faults).

Body: the report JSON (`schemaVersion 2`, includes `trigger:{auto,kind,...}` and `reportId`).
Saved to `PianoidCore/logs/reports/bugreport-<createdAt>-<auto-<kind>|assistant-<kind>|manual>-<reportId|hex6>.json`
(dir auto-created; oldest pruned beyond 500 files). `assistant-<kind>` = a report filed by the assistant's
`bug.report` (`trigger: {auto: false, source: "assistant", kind: app_bug|environment|feature_request}`, dev-947d / dev-obuf1). `PIANOID_REPORTS_DIR`
overrides the folder (an isolated / worktree backend writing into the main checkout's store). The collector is wrapped so
it can never take the backend down.

**Idempotent by `reportId` (dev-2cce).** A report with a `reportId` always maps to the same
file, created exclusively: a re-delivery (the client timed out while a large report was still
being saved, then flushed its localStorage copy) answers `200` with `"duplicate": true` and is
not saved again, so the first (full) copy is kept. Without a `reportId` the suffix is a random hex6.

**One fault, one report across tabs (dev-16af).** Every open tab runs its own auto-reporter, so one backend
fault used to be filed once per tab (2026-10-20 16:57Z: two tabs, two reports). An AUTO report whose
fingerprint — `trigger.episode` (the FE episode key: `backend_fault`, `endpoint_unresponsive:<host>`,
`js_error:<message>` …), else `trigger.kind` — matches one saved within `PIANOID_REPORT_DEDUP_S` (default
`120` s, `0` disables) of its own `createdAt` (so late lifeboat flushes still match) is not saved: `200
{"ok": true, "duplicate": true, "duplicate_of": "<first file>", "saved": "<first file>"}` and an info log line.
Manual and assistant reports are never de-duplicated. The index is in memory per reports folder
(`pianoid_middleware/bug_report_dedup.py`): a duplicate arriving after a backend restart is saved again.
Why server-side and not tab leadership: the collector is the one owner that sees every tab (and every
browser); a leader-only reporter would drop a fault only a follower tab saw, and leadership changes hands.

Response `200`:
```json
{"ok": true, "saved": "bugreport-...-auto-backend_exception-a1b2c3.json",
 "path": "<abs>", "auto": true, "kind": "backend_exception"}
```
`400` if the body is not a JSON object or carries an unknown `severity`; `500` (with `{ok:false,error}`) on a write failure.

**Triage fields (dev-obuf1).** The collector stamps every new report `status: "open"`, `resolution: null` and
checks `severity` (`critical` | `high` | `medium` | `low` | absent = `null`, not triaged). Owner:
`pianoid_middleware/bug_reports.py`; see [Bug reports](#bug-reports).

---

### Bug reports

Triage of the report store (dev-obuf1, owner `pianoid_middleware/bug_reports.py`). Never engine-gated (the
store, not the engine). The file name never changes (it carries the original kind); the content is the truth.

| Field | Values |
|---|---|
| `severity` | `critical` · `high` · `medium` · `low` · `null` (not triaged) |
| `status` | `open` (every new report) · `fixed` · `wontfix` · `duplicate` |
| `resolution` | `null` while open; else `{note, commits: ["Core d99e5a0", …], duplicate_of, at, by}` |
| `trigger.kind` | the kind; a triage may re-class to `app_bug` · `environment` · `feature_request` (auto reports carry their fault kind, e.g. `backend_crashed`) |
| `triage_history` | every status change `{at, by, from, to, note}` |

#### `GET /bug_reports`

Summaries, newest first. Query: `status`, `kind`, `source` (`assistant` · `auto` · `manual`), `severity` (or `none`
= not triaged), `limit` (1–500, default 50). `400` on an unknown filter value.
```json
{"ok": true, "count": 1, "total": 1, "unreadable": 0, "reports": [
  {"reportId": "8761b5c46b1b49fb", "file": "bugreport-...-assistant-app_bug-8761b5c46b1b49fb.json",
   "createdAt": "2026-10-18T10:35:04.155Z", "source": "assistant", "kind": "app_bug",
   "title": "Keyboard sweep render returns a WAV ...", "component": "render.keyboard ...",
   "severity": "high", "status": "fixed",
   "resolution": {"note": "...", "commits": ["Core <sha>"], "duplicate_of": null, "at": "...", "by": "dev-obuf1"}}]}
```

#### `POST /bug_reports/<report_id>/status`

`report_id` = the id (file-name suffix) or a unique prefix of at least 6 characters. Body: at least one of
`status`, `severity`, `kind`, plus `resolution` (note), `commit` / `commits`, `duplicate_of`, optional `by`
(else the `X-Pianoid-Source` header, else `rest`). A non-open status needs a `resolution` note; `duplicate` also
needs `duplicate_of`; back to `open` clears `resolution` (the history keeps it). Written atomically. `200 {ok,
report: <summary>}`; `400` invalid value / missing note / ambiguous id; `404` no such report.
```json
{"status": "fixed", "resolution": "offline buffer de-interleaved (PianoidResult.load_offline_channels)", "commit": "Core 1a2b3c4"}
```

---

## Preset Library Endpoints

The preset library follows the **working-copy model** (2026-05-18). Every
library entry has a **kind**: `original` (a read-only snapshot of an on-disk
preset) or `working` (an editable copy spawned from an original). Parameter
edits are rejected while an `original` is active — see the `preset_read_only`
409 below. See [DATA_FLOWS.md §2.8 "Working-Copy Model"](../../architecture/DATA_FLOWS.md).

### `GET /preset/list`

Returns the preset library entry records and the active preset name. Requires
a loaded pianoid instance.

Response `200`:
```json
{
  "presets": [
    { "name": "Steinway",            "kind": "original", "source": "Steinway", "path": "presets/Steinway.json" },
    { "name": "Steinway (working 1)", "kind": "working",  "source": "Steinway", "path": null }
  ],
  "active": "Steinway (working 1)"
}
```

Each record: `name`, `kind` (`original`|`working`), `source` (the originating
original's name; an original's `source` is itself), `path` (on-disk JSON path
for originals, `null` for working copies).

Response `400` if pianoid not initialized.

---

### `POST /preset/load`

Loads a preset JSON file into the GPU preset library as a read-only `original`
entry, without activating it.

Request body:
```json
{ "path": "presets/Steinway_256modes.json", "name": "Steinway" }
```

- `path`: path to preset JSON file (relative to middleware working directory)
- `name`: unique identifier for this preset in the library

Response `200`: `{ "message": "...", "presets": [<records>] }`

Response `400` if `path` or `name` missing.
Response `409` (`PresetLibraryError`) if the name is already in the library, or if the preset's
string layout differs from the running engine (`num_strings` after the array-size geometry
scaling — e.g. `F15_Elyashev_array512` has 232 strings, a Belarus engine 224). A library slot is
D2D-swapped into the running engine, so it must share its layout; load such a preset with
`POST /load_preset` (APPLY) instead. (dev-17fd; was a `ModeMap` ValueError → 500.)
Response `500` if the file is not found or another unexpected error occurs.

---

### `POST /preset/switch`

Switches the active synthesis parameters to a named preset from the GPU
library. Double-buffered atomic swap — playback continues without glitches.

Switching away from a `working` copy first saves its live edits back to its
slot; switching away from an `original` never writes back (originals stay
pristine). Volume / feedback / volume-sensitivity are global library-wide and
are preserved across the switch.

Request body: `{ "name": "Steinway (working 1)" }`

Response `200`: `{ "message": "...", "active": "<name>" }`

Response `400` if `name` missing.
Response `500` if preset not found in library.

**Note:** uses `async_switch=False` (synchronous).

---

### `POST /preset/spawn_working_copy`

Spawns a new editable `working` copy from an existing library entry. The copy
duplicates the source's *current* state (live edits included) and is
auto-labelled `<original> (working N)`.

Request body: `{ "source": "Steinway" }`

Response `200`:
```json
{
  "message": "Spawned working copy Steinway (working 2)",
  "name": "Steinway (working 2)",
  "presets": [<records>],
  "active": "<active name>"
}
```

Response `400` if `source` missing.
Response `409` (`PresetLibraryError`) if `source` is not a library entry.

---

### `POST /preset/promote`

Promotes a `working` copy: atomically overwrites its source original's on-disk
JSON file with the working copy's current model (permanent — survives restart),
then refreshes the in-memory original. **Destructive** — overwrites a file on
disk; the frontend confirms before calling this.

Request body: `{ "name": "Steinway (working 2)" }`

Response `200`: `{ "message": "...", "original": "Steinway", "presets": [<records>] }`

Response `400` if `name` missing.
Response `409` (`PresetLibraryError`) if `name` is not a working copy, or its
original has no on-disk path.

---

### `POST /preset/unload`

Removes a preset from the GPU library. Any entry — including the boot preset —
is unloadable as long as at least one preset remains loaded. When the unloaded
entry is active, the engine switches to a replacement first; when an `original`
is left with no working copies, a fresh one is auto-spawned.

Request body: `{ "name": "Steinway (working 1)" }`

Response `200`: `{ "message": "...", "presets": [<records>], "active": "<active name>" }`

Response `400` if `name` missing.
Response `409` (`PresetLibraryError`) if this would unload the last preset.

---

### Read-only enforcement — `preset_read_only` 409

Parameter-edit endpoints (`POST /set_parameter/*`, `POST /set_string_excitation/*`,
`POST /set_hammer_shape/*`, `POST /excitation_energy`) and every calibration mass commit reject writes
while a read-only `original` is the active preset (the guard is the first step of the write machinery
`edit_commit.commit` — and the `param` routes check it UP FRONT; before dev-960f `/excitation_energy` and the calibration family edited a
read-only original silently). The orchestrator guard
`Pianoid._assert_active_editable()` raises `PresetReadOnlyError`, which the
dedicated error handler maps to:

```
HTTP 409
{ "error": "PresetReadOnlyError",
  "message": "Preset '<name>' is read-only. Spawn a working copy to edit.",
  "code": "preset_read_only" }
```

The matching WebSocket handlers emit an `error` event with
`code: "preset_read_only"`. Runtime-parameter writes (`/set_runtime_parameters`
— volume / feedback) are **exempt**: they are global, not preset-block edits.

---

## System / Preset Endpoints

### `GET /command_names`

**Deprecated** — superseded by `GET /commands` ([Commands and jobs](#commands-and-jobs-i4)). Returns a stub list.

Response `200`:
```json
{"commands": ["volume"], "message": "OK"}
```

---

### `GET /get_string_map`

Returns string layout data from `pianoid.sm.get_string_map()`.

Response `200`: string map dictionary (structure defined by `StringMap` domain class).

---

### `GET /get_block_map`

Returns the block-to-string mapping from `pianoid.sm.get_strings_for_stringmap_manager()`.

Response `200`: block map array.

---

## Calibration Endpoints

These endpoints use the **semi-offline calibration mode**: the engine loop is stopped but the audio driver stays alive, allowing deterministic cycle-by-cycle synthesis and microphone capture. See [MIC_VOLUME_EQUALIZATION_PLAN.md](http://localhost:8001/development/archive/MIC_VOLUME_EQUALIZATION_PLAN/) (archived) for the original architecture.

**Loudness lever = per-pitch `hammer_mass` (dev-168c, 2026-10-04).** Every equalizer write changes only
`pitch.physics.hammer_mass` and recomposes that pitch's excitation coefficient
(`c·m·v / (temporal·spatial)`, conserve mode) — the same path as `POST /excitation_energy` (one
`ParameterUpdateRequest(kind='excitation_energy')` per `HammerMassGain.commit()` — masses are STAGED
off-model until then and dropped on cancel / error, so the model only changes through the write
machinery: read-only guard, Layer B policy, one `state_changed` with `source.kind = 'calibration'`). The excitation
curve volumes are never touched: they divide back out of the coefficient, so the old curve-volume writes were
no-ops after any reload. Loudness is linear in mass (measured: mass ×0.25/×0.5/×2/×4 → −12.04/−6.02/+6.02/+12.04 dB
±0.002 dB). Consequences:

| Writer | Effect |
|---|---|
| `/calibrate_synthesis`, `/calibrate_acoustic`, `/tune_note`, `/apply_perception`, `/normalize_volume`, `/calibration_curve/apply` · `/revert` · `/rcm/remove` | scale / set / restore `hammer_mass` of the affected pitches; the reported `coefficient` is the pitch's gain = mass ÷ mass when the calibration controller was created (1.0 = unchanged) |
| velocity level of a correction | mass is **per-pitch**: a correction measured at one velocity moves every level of that pitch. Per-level loudness is `hammer_speeds` (`/excitation_energy`), untouched by the equalizer |
| `level_multipliers` (`/calibration_params`) | **retired** — `400`; the stored list is kept read-only (legacy preset field) |
| RCM auto-capture | triggered by `POST /excitation_energy` `hammer_mass` edits (coefficient = mass ÷ mass at RCM start), no longer by gauss edits |
| persistence | `hammer_mass` is saved per pitch in the preset `physics` block → survives save → reload; mass is a by-design loudness edit — `output_scale_calibrated` is NOT cleared (dev-5852) and a later re-calibration keeps the mass-driven level (impulse reference) |
| physical range | at the end of every measurement pass (`/calibrate_synthesis`, `/calibrate_acoustic`, `/tune_note`, `/normalize_volume`, auto-tune) and via `POST /rescale_hammer_mass`, ALL key pitches' masses are multiplied by ONE common factor `k` into `HAMMER_MASS_MIN…MAX` = 2–20 g (ratios kept → evenness kept); `output_scale` and the live `volume_center` are multiplied by `1/k` (analytic, no render) so the absolute level is unchanged. If the mass spread exceeds the 20 dB range, the heaviest mass is pinned to 20 g and the light end is reported below 2 g (`violation_db`, `n_outside`). The returned/embedded `mass_rescale` report carries `k`, spread/range dB and min/median/max grams before/after |

### `POST /measure_rms`

Measures RMS for a single pitch via microphone. Automatically enters and exits semi-offline calibration mode.

Request body:
```json
{
  "pitch": 60,
  "velocity": 95,
  "repetitions": 3
}
```

- `pitch` (required): MIDI pitch number
- `velocity` (optional, default `95`): MIDI velocity 0-127
- `repetitions` (optional, default `1`): number of measurements to take. When > 1, takes multiple samples and returns the median to reject outliers. Internal calibration workflows (equalize, tune) use 3 repetitions by default.

Response `200`:
```json
{
  "rms": 0.00234,
  "peak": 0.0089,
  "spectralEnergy": 0.0018,
  "db": -52.6,
  "capturedFrames": 24000,
  "analyzedFrames": 14400
}
```

Response `400` if `pitch` missing or pianoid not initialized.
Response `500` on measurement error.

---

### `POST /equalize_keyboard`

**Deprecated — returns `410`** (superseded by `/save_reference` → `/calibrate_synthesis` → `/calibrate_acoustic`). Historical contract below.

Starts full keyboard equalization in a background thread. Measures every available pitch and adjusts excitation volume coefficients to match a reference pitch's RMS.

Two-phase process per pitch: noise floor lift (boost until signal above noise), then direct linear correction (1-2 measurements using RMS = K * excitation linearity, with bisection fallback). Poll progress via `GET /calibration_status`.

Request body:
```json
{
  "reference_pitch": 60,
  "velocity": 95,
  "reference_rms": 0.01
}
```

- `reference_pitch` (required): MIDI pitch to use as the equalization target
- `velocity` (optional, default `95`): MIDI velocity for all measurements
- `reference_rms` (optional): pre-measured RMS of reference pitch. If omitted, the reference is measured first.

Response `200`:
```json
{
  "status": "started",
  "message": "Keyboard equalization started in background"
}
```

Response `400` if `reference_pitch` missing or pianoid not initialized.
Response `409` if calibration is already in progress.
Response `500` on error.

---

### `POST /tune_note`

Adjusts the pitch's `hammer_mass` (loudness gain; `coefficient` = mass ÷ reference mass) to match the target dB using direct linear correction (1-2 measurements). Falls back to bisection search if direct correction overshoots. Blocking -- returns when tuning completes.

Request body:
```json
{
  "pitch": 60,
  "velocity": 95,
  "target_db": -35.0
}
```

- `pitch` (required): MIDI pitch number
- `velocity` (optional, default `95`): MIDI velocity 0-127
- `target_db` (required): target RMS level in decibels (e.g. `-35.0`)

Response `200` (converged):
```json
{
  "rms": 0.0178,
  "db": -35.0,
  "iterations": 2,
  "converged": true,
  "coefficient": 1.234,
  "method": "direct"
}
```

`method` values: `direct` (converged via linear correction), `direct_noop` (already at target), `direct_no_verify` (small correction, skipped verification), `bisection_fallback_zero` / `bisection_fallback_clip` / `bisection_fallback_overshoot` (fell back to bisection).

Response `200` (did not converge):
```json
{
  "rms": 0.0195,
  "db": -34.2,
  "iterations": 5,
  "converged": false,
  "coefficient": 1.456,
  "method": "bisection_fallback_overshoot"
}
```

Response `400` if `pitch` or `target_db` missing, or pianoid not initialized.
Response `500` on error.

---

### `POST /rescale_hammer_mass`

Moves every key pitch's `hammer_mass` into the physical range (2–20 g) with one common factor and compensates the level through `output_scale` (dev-168c). No body. Response `200`: `{"status":"ok","k":…,"k_db":…,"spread_db":…,"range_db":20.0,"fits":bool,"violated_bound":null|"lower","violation_db":…,"n_outside":…,"grams_before":{min,median,max},"grams_after":{…},"range_grams":[2.0,20.0]}`. `400` no preset · `409` calibration running · `500` error.

---

### `POST /calibrate_attack`

**A-weighted attack equalization** — the Virtual Piano **Calibrate** button (dev-89f7), registry command
`calibration.attack_equalize` (calibration job family, approval `per_command`: its own rule, Ask by default). Equalizes what the ear hears
first: every key's A-weighted level in the first 300 ms after its onset, energy-summed over the heard channels,
to the reference key, by per-key `hammer_mass`. (`/calibrate_synthesis` matches a 30–300 ms *flat* RMS: on
F15_measured_plywood it left the treble +13…+21 dB louder at the attack, A-weighted.) Procedure from the
assistant's manual run (bug reports `2026-10-18T11-34-56` / `11-52-34`).

Body: `{"reference_pitch": 62, "velocity": 95, "pitches": "all", "tolerance_db": 0.5, "max_passes": 3,
"channels": null, "window_ms": 300}` — `reference_pitch` required (a key of the preset; its mass is never
changed); `velocity` 1–127; `pitches` = `"all"` (key pitches) or a list; `tolerance_db` 0.01–6;
`max_passes` 0–10 (`0` = **measure only**: renders and reports `before_db`, writes nothing); `channels` = output channels to measure, default **every unmuted channel**; `window_ms` 50–2000.

| Step | What |
|---|---|
| session | ONE calibration session (`enter_calibration_mode(keep_audio=True)` once): the realtime engine stops once for the whole run and restarts at the end — no per-key restart |
| render | per key: `SynthesisTuner.render_note` (string state reset, note-on, held `window_ms` + 150 ms, offline, record buffer de-interleaved to all output channels) |
| metric | per channel the IEC 61672 A-weighting (analog prototype, bilinear, 0 dB at 1 kHz; −3.7 dB at 10 kHz at 48 kHz, inside class 1); onset = the A-weighted energy envelope (sum over channels, 1 ms smoothing) first reaching −40 dB of its peak; `L = sqrt(Σ_ch RMS_ch²)` over `[onset, onset + window_ms)` |
| channels heard | the engine output channels the mute masks leave ON (`mute_ops.channel_states`: strings mode `feedback_mask` rows of output pitches 128+ch, modes mode `sound_channel_mask`). `PIANOID_AUDIO_OUTPUT_MAP` only routes channel k to output `map[k]` and drops none. All muted → `job_failed` |
| correction | `m_k ×= L_ref / L_k` (loudness is linear in mass), clamped to the Mass-workbench range **0.1 g … 1 kg** (clamped keys reported); committed per pass through `HammerMassGain.commit` (the write machinery) |
| iteration | re-measure only the corrected keys; repeat until every key is within `tolerance_db` or `max_passes`; keys already inside are never touched; the reference is re-rendered at the end (`reference_drift_db`, the key-isolation check) |
| level | **no** physical-range rescale and **no** `output_scale` change (undo cannot restore `output_level`: the mass-only result undoes completely). Never calls `calibrate_output_scale` |
| undo | the worker writes in ONE explicit group — the request's `X-Pianoid-Group` / WS `groupId`, else `attack-eq-<id>` — returned as `group`; `POST /history/undo {"group": …}` restores every mass |

Response `200` `{status: "started", step: "attack_equalize", group, reference_pitch, pitches, velocity, jobId}`;
`400` no preset / invalid body / reference not a key · `409` a calibration is running. The job (`job_finished`)
result: `{reference_pitch, velocity, channels, window_ms, tolerance_db, load_settings (the result is valid at
these), reference_level, reference_drift_db, before_db / after_db {pitch: dB re reference}, max_abs_dev_before_db,
max_abs_dev_after_db, std_before_db, std_after_db (over all keys incl. the reference), converged, passes [{passes,
max_abs_db, std_db, corrected}], clamped {pitch: min|max}, silent [pitch], mass_grams_before / _after, renders,
runtime_s, cancelled, group}`. `job.cancel` stops after the current render (`job_cancelled`, passes already
committed stay — Undo restores them).

---

### `GET /calibration_status`

Returns the current calibration progress. Used to poll `equalize_keyboard` status from the frontend.

Response `200` (not running):
```json
{
  "running": false,
  "progress": 0.0
}
```

Response `200` (in progress):
```json
{
  "running": true,
  "progress": 0.45,
  "current_pitch": 57,
  "current_level": null,
  "pitches_completed": 10,
  "results": {
    "48": {"rms": 0.0023, "db": -52.8, "correction": 1.23, "noise_boosted": false, "boost_iterations": 0}
  },
  "corrections": {
    "48": {"3": 1.23}
  },
  "step": "calibrate_synthesis",
  "message": "Synthesis cal: pitch 57 (10/84)",
  "clipping_pass": false
}
```

- `step`: name of the current pipeline step (e.g. `calibrate_synthesis`, `calibrate_acoustic`). `null` before the first progress emission.
- `message`: human-readable progress message for the current step.
- `clipping_pass`: `true` while `calibrate_synthesis` is running its **second sweep**. The synthesis step is single-pass, but when it detects that pitches would clip it reduces the target level and re-runs every pitch — so `progress` legitimately restarts `0.0 → 1.0` a second time. The frontend uses this flag to label the rerun ("Pass 2/2: clipping correction") instead of showing what looks like an unexplained restart. Reset to `false` at the start of each calibration and once the step completes.

---

### `POST /calibration_cancel`

Cancels a running calibration pass (synthesis / acoustic). The pass stops after the current pitch completes. (Until dev-6026 the synthesis and acoustic passes ignored the cancel and ran to the end: the tuners poll a copy of the running flag that `cancel()` now flips too. A pass the engine refuses — not `PLAYBACK_ACTIVE` — no longer leaves the controller `running`, which used to 409 every later pass.)

Response `200`:
```json
{"status": "cancelled"}
```

Response `200` (no calibration running):
```json
{"status": "not_running"}
```

---

### `GET /mic_devices`

The mic capture input (`startMicCapture`, `play.keyboard capture_mic`, acoustic calibration records
ONE input). Logic: `mic_input.py` (dev-d191). Assistant read: `calibration.mic_devices`.

Response `200`, not ASIO (`asio: false`, choose a device by name):
```json
{"devices": ["Microphone (Realtek)", "Line In"], "asio": false}
```

Response `200`, ASIO open (`asio: true`): the one device is the driver; the choice is its physical
input. `inputs` = the open device's channel table (`asio_device_info`), `input_channel` = the input
the capture records (default `0` = In 1):
```json
{"devices": ["UMC ASIO Driver"], "asio": true, "input_channel": 2,
 "inputs": [{"index": 0, "name": "In 1", "supported": true}, {"index": 1, "name": "In 2", "supported": true}]}
```

`{"devices": []}` if pianoid is not initialized; `{"devices": [], "error": ...}` on a driver error.

---

### `POST /set_mic_device`

Selects the mic capture input. Request body, any of:

| Field | Meaning |
|---|---|
| `device` | Not ASIO: input device by name (`""` = system default). Omitting both fields = `device: ""` (system default). |
| `input_channel` | ASIO: the physical input (0-based index into `inputs` of `GET /mic_devices`). |

Response `200`: `{"status": "ok", "device": "Microphone (Realtek)"}` and/or `{"status": "ok", "input_channel": 2}`
(`input_channel` = the stored value read back from the engine).

| Error | When |
|---|---|
| `400` | pianoid not initialized; `input_channel` not an integer; the open device has no such input, or its sample type is unsupported (engine `ValueError`, e.g. `ASIO input 42 outside 0..17 of 'UMC ASIO Driver'`) |
| `409` | `input_channel` with no ASIO device open (SDL3 / no driver) |
| `501` | the installed `pianoidCuda` predates `setAsioCaptureInput` (rebuild) |
| `500` | the driver refuses the device |

**Ownership.** The ASIO input is owned by the engine (`ASIOAudioDriver::setCaptureInputChannel`,
module functions `pianoidCuda.setAsioCaptureInput` / `getAsioCaptureInput`): one process-wide value,
kept across preset loads and driver re-opens; a newly opened device that lacks it resets it to 0
(In 1, logged). The bufferSwitch capture reads it lock-free. The non-ASIO device selection lives in
the SDL3 driver (lost on a preset load, no read-back). Each change is a `session_changed{mic}` event.
The UI selector is `MicDeviceSelector` in the **Calibration Settings** pane (on ASIO an input picker).
The measurement session `POST /audio/session` chooses its own inputs (and pauses synthesis);
this setting is for the mic capture during synthesis only.

---

### `POST /calibrate_volume`

**Deprecated — returns `410`** (use `/calibrate_synthesis`). Historical contract below.

Starts multi-velocity calibration in a background thread. Measures and corrects volume across selected velocity levels and pitches.

Request body:
```json
{
  "velocity_levels": [0, 1, 2, 3, 4, 5],
  "pitches": "all",
  "target_rms": 0.01
}
```

- `velocity_levels` (optional): list of base level indices (0-5) to calibrate. Default: all levels
- `pitches` (optional): `"all"` or comma-separated pitch list. Default: `"all"`
- `target_rms` (optional, default `0.01`): target RMS level

Response `200`:
```json
{"status": "started", "message": "Calibration started in background"}
```

Poll progress via `GET /calibration_status`.

---

### `GET /calibration_params`

Returns perception curves, timing bands, level multipliers, and reference settings for the Calibration UI panel.

Response `200`:
```json
{
  "perception_curves": {"21": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0], ...},
  "timing_bands": [{"max_freq": 131.0, "settle_ms": 500, "skip_ms": 100, "window_ms": 300}, ...],
  "reference_target_db": -50,
  "reference_pitch": 60,
  "level_multipliers": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
}
```

---

### `POST /calibration_params`

Updates calibration parameters in-memory. Supports partial updates.

Request body (all fields optional):
```json
{
  "perception_curves": {"21": [1.2, 1.1, 1.0, 0.95, 0.9, 0.85], ...},
  "timing_bands": [...],
  "reference_target_db": -50,
  "reference_pitch": 60,
  "level_multipliers": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  "generate_defaults": false,
  "save_to_preset": false
}
```

- `generate_defaults`: if `true`, returns ISO 226-based default perception curves without applying
- `save_to_preset`: if `true`, persists calibration data to the preset JSON file
- `level_multipliers`: **retired (dev-168c)** — posting it returns `400` ("set the per-level hammer_speeds via POST /excitation_energy"). It scaled the curve volumes, which the conserve-mode coefficient divides out. `GET` still returns the stored list (legacy preset field, not applied)

Response `200`:
```json
{"status": "ok", "updated": {"perception_curves": 88, "timing_bands": true}}
```

---

## Modal Adapter Endpoints (port 5001)

Served by `modal_adapter_server.py` on port 5001. ESPRIT-based modal extraction pipeline, project management, and folder dialogs. All `/modal/*` endpoints use stage-based architecture with independent stage execution and auto-persistence.

### Error Status Codes

All `/modal/*` endpoints return JSON error responses `{"error": "<message>"}` with the following status classification (F18, W4-A):

| Status | Mapped from | When |
|--------|-------------|------|
| `400` | `ValueError`, `TypeError`, `KeyError` | Bad request payload (malformed JSON, missing/invalid keys, schema mismatch) |
| `404` | `FileNotFoundError` | A resource (project, measurement file, export) does not exist |
| `409` | `RuntimeError` | Server state conflict — no project open, ModalAdapter not initialized, pipeline in wrong stage |
| `503` | `ModalAdapterOnlyError` | The requested route is main-server-only (port 5000) and was hit on the modal-adapter server (port 5001) |
| `500` | Any other exception | Unexpected server bug — logged with traceback |

Routes may still return explicit codes (e.g. export endpoints return `404` for "not found" inside the happy path); the automatic classification applies to uncaught exceptions routed through `_error()`.

### Server Role & Cross-Process Routes

Routes that mutate the running synthesis engine (`POST /modal/apply_to_preset`) require a live `Pianoid` instance and therefore only work when served by the **main** backend (port 5000). When served by the standalone **modal adapter** server (port 5001), these routes respond `503` with message `"This route only runs on the main server at port 5000 ..."` (F9, W4-A). Each server advertises its role via the Flask `app.config['role']` attribute (`'main'` / `'modal_adapter_server'`).

The main backend provides its own `POST /modal/apply_to_preset` route (defined in `backendServer.py`, not via the blueprint) — it rehydrates a fresh `ModalAdapter` instance from the project directory on disk and applies to the local `pianoid`. The frontend (`useModalAdapter.applyToPreset`) posts directly to port 5000 for this route while all other `/modal/*` calls target port 5001. See the `POST /modal/apply_to_preset` entry under Stage 7 below for the main-server payload shape.

### Utility Endpoints

#### `GET /health`

Returns lifecycle status of the modal adapter server.

---

#### `POST /shutdown`

Graceful shutdown of the modal adapter server.

---

#### `POST /open_folder_dialog`

Opens the native OS folder picker (tkinter `askdirectory` in a subprocess) and returns the selected path. The dialog appears on top of all windows. Runs in a subprocess so tkinter gets its own main thread — calling tkinter from a Flask worker thread hangs on Windows. Used by the frontend `FolderBrowser` component for measurement folder selection.

Request:
```json
{
  "title": "Select Measurement Folder",
  "initial_dir": "D:\\tmp"
}
```

Response `200`:
```json
{"path": "D:\\tmp\\belarus_78_extended_8band", "cancelled": false}
```

Response `200` (user cancelled):
```json
{"path": "", "cancelled": true}
```

---

#### `GET /modal/defaults`

Returns pipeline defaults shared between backend and frontend (F16, W4-A). Replaces hardcoded duplicates (`bridge_boundary=28`, `pitch_offset=21`) in both layers with a single source of truth derived from `MappingConfig` dataclass defaults and `DEFAULT_ESPRIT_PARAMS`.

The frontend (`useModalAdapter.js`) fetches this endpoint once on mount and uses the values as initial `bridgeBoundary` / `pitchOffset` / `trackingParams` state. Hardcoded fallbacks remain in the frontend as a first-render guard when the modal adapter server is not yet reachable.

Response `200`:
```json
{
  "bridge_boundary": 28,
  "pitch_offset": 21,
  "tracking_params_default": {
    "bridge_boundary": 28,
    "freq_tol_pct": 0.02,
    "max_gap": 3,
    "tracking_method": "nuclei_merge"
  },
  "esprit_config_default": {
    "band_preset": "extended_8band",
    "mac_threshold": 0.9,
    "freq_tol_pct": 0.01,
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2,
    "window_length": 2000
  }
}
```

`bridge_boundary` and `pitch_offset` are top-level aliases into `tracking_params_default` (kept flat for the most common frontend consumers).

`tracking_method` is mirrored from the backend `TrackingConfig` dataclass default — currently `"nuclei_merge"` (since dev-d773, 2026-05-05). The frontend `useModalAdapter.js` overlays this onto its hardcoded `DEFAULT_TRACKING_PARAMS` on mount so a future flip of the backend default propagates without a frontend code change.

---

### Data Status & Pipeline

#### `GET /modal/data_status`

Returns availability flags for each pipeline stage. Used by the frontend to determine which stages can run independently. When ESPRIT data exists, includes `esprit_config` with the parameters used for the last ESPRIT run (band preset, resolved bands, GPU/TLS flags, etc.) so the frontend can restore the configuration on project reopen.

Response `200`:
```json
{
  "measurements": true,
  "mapping": true,
  "esprit": true,
  "tracking": false,
  "feedin": false,
  "channel_mapping": false,
  "applied": false,
  "esprit_config": {
    "band_preset": "extended_8band",
    "preset": "extended_8band",
    "bands": [
      {"name": "Ultra-Low", "f_min": 30, "f_max": 100, "filter_order": 4, "decimation": 1, "exp_factor": 0.15, "model_order": 8, "window_length": 12000},
      {"name": "Low", "f_min": 80, "f_max": 200, "...": "..."}
    ],
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2,
    "mac_threshold": 0.9,
    "window_length": 2000
  }
}
```

`esprit_config` is only present when `esprit` is `true`. The `bands` array contains the actual resolved frequency bands used for processing (not just the preset name).

---

#### `GET /modal/project_state`

Returns complete project state in a single response. Combines project metadata, data availability flags, all configuration, and applied status. Designed to replace multiple individual GET calls from the frontend.

Response `200`:
```json
{
  "project_name": "belarus_78",
  "project_dir": "D:\\modal_projects\\belarus_78",
  "projects_base": "D:\\modal_projects",
  "measurement_info": {
    "num_scenarios": 78,
    "num_channels": 5,
    "sample_rate": 48000.0,
    "scenario_indices": [0, 1, 2, "..."]
  },
  "data_status": {
    "measurements": true,
    "mapping": true,
    "esprit": true,
    "tracking": true,
    "feedin": true,
    "applied": false
  },
  "mapping_config": {
    "channel_roles": {"0": "force", "1": "response", "...": "..."},
    "bridge_boundary": 28,
    "pitch_offset": 21,
    "excitation_to_pitch": {"0": 21, "1": 22, "...": "..."},
    "skipped_channels": []
  },
  "channel_mapping": {"0": 0, "1": 1},
  "esprit_config": {
    "preset": "extended_8band",
    "bands": ["..."],
    "use_gpu": true,
    "use_tls": true,
    "max_damping": 0.2
  },
  "tracking_params": {
    "freq_tol_pct": 0.02,
    "max_gap": 3
  },
  "applied": false
}
```

Fields are `null` when data is not available (e.g., `measurement_info` is `null` before loading measurements, `tracking_params` is `null` before running tracking). `mapping_config` contains channel roles, bridge geometry, and the response-channel-to-sound-output mapping (`channel_to_sound`). The top-level `channel_mapping` field is a convenience view onto `mapping_config.channel_to_sound` (same data, flat dict) — kept for backward compatibility. On-disk storage is `modal_adapter/mapping/mapping_config.json` only; legacy projects with a standalone `channel_mapping.json` are auto-migrated into `mapping_config.json` on `open_project`. Old projects without `tracking/config.json` or `output/applied.json` get default values (`null` and `false`).

---

#### `POST /modal/run_pipeline`

Runs the full extraction pipeline (load → mapping → ESPRIT → tracking → feedin) in a background thread. Returns immediately with a task ID. Poll progress via `GET /modal/status`.

Payload key names match the frontend exactly — `esprit_config` and `tracking_params` (not the legacy `esprit_params` / `tracking` names). Sending the old keys is silently ignored and the pipeline runs with defaults.

Request body:
```json
{
  "folder_path": "/path/to/measurements",
  "sample_rate": 48000,
  "scenarios": [10, 40, 70],
  "mapping": {
    "excitation_to_pitch": {"0": 36, "1": 48},
    "channel_to_sound": {"0": 0, "1": 1},
    "skipped_channels": [],
    "channel_roles": {"0": "response", "1": "response"},
    "bridge_boundary": 28,
    "pitch_offset": 21
  },
  "esprit_config": {"band_preset": "extended_8band"},
  "tracking_params": {"bridge_boundary": 28, "freq_tol_pct": 0.02, "max_gap": 3},
  "response_channels": [0, 1],
  "feedin_method": "mode_shape"
}
```

All fields are optional. Two guards protect against silent data loss when re-running the pipeline on an already-open project:

- **Measurements reuse.** If `folder_path` is omitted or matches the currently-loaded source folder, `load_folder` is skipped — the existing `_measurements`, `_mapping`, `_results`, and `_applied` state is preserved.
- **Mapping preservation.** If `mapping` is omitted AND the adapter already has a mapping loaded, the existing `_mapping` is reused. If the adapter has no mapping and `mapping` is absent, the pipeline errors immediately with `"mapping required when adapter has no existing mapping loaded"`.

Response `200`:
```json
{"task_id": "modal_pipeline"}
```

Response `409` if ModalAdapter not initialized or pipeline is in a conflicting state (see Error Status Codes table above).

---

### Stage 1: Load Measurements

#### `POST /modal/load_folder`

Load impulse response measurements from a folder. Auto-detects direct `.npy` files or RoomResponse per-channel scenario structure.

Request body:
```json
{
  "path": "/path/to/measurements",
  "sample_rate": 48000,
  "scenarios": [10, 40, 70]
}
```

- `scenarios` (optional): specific scenario indices for RoomResponse format

Response `200`: measurement info (excitation points, channels, sample rate, file list).

---

#### `POST /modal/upload_measurements`

Upload measurement arrays as multipart form data.

Form fields: `sample_rate` (required). File fields: numbered keys (`0`, `1`, ...) with `.npy` files.

Response `200`: measurement info.

---

#### `GET /modal/measurement_info`

Returns metadata about currently loaded measurements.

---

### Stage 2: Mapping & Configuration

#### `POST /modal/mapping`

Set the mapping from measurement points to MIDI pitches, channel roles, and bridge geometry.

Request body:
```json
{
  "excitation_to_pitch": {"0": 36, "1": 48, "2": 60},
  "channel_to_sound": {"0": 0, "1": 1},
  "skipped_channels": [3, 4],
  "channel_roles": {"0": "response", "1": "response", "2": "force", "3": "response", "4": "response", "5": "reference"},
  "bridge_boundary": 28,
  "pitch_offset": 21
}
```

---

#### `POST /modal/esprit_config`

Persist ESPRIT configuration to the project's `esprit/config.json`. This is the user's intended config, independent of whether ESPRIT has been run. Saved config is returned by `data_status` and used as defaults when running ESPRIT.

Request body: same shape as `espritConfig` in the frontend.

#### `GET /modal/esprit_config`

Load saved ESPRIT configuration from `esprit/config.json` (single source of truth). Returns `{}` if no config has been saved. Never falls back to `esprit/metadata.json` — that file holds run provenance only (`scenario_count`, `scenario_indices`, `run_at`). A successful ESPRIT run overwrites `config.json` with the params actually used so the on-disk results and saved config never diverge. Legacy projects with `params` embedded in `metadata.json` are migrated to `config.json` automatically on `open_project`.

#### `GET /modal/gpu_status`

Check CuPy GPU availability.

Response `200`:
```json
{ "gpu_available": true, "gpu_name": "NVIDIA GeForce RTX 3080" }
```

#### `GET /modal/band_presets`

Return available band preset configurations (standard_4band, extended_8band) with per-band parameters.

**dev-esrt Phase 3 (2026-05-06):** the response also includes user-saved
named presets loaded from `<projects_base>/.user_band_presets.json`
(see `POST /modal/band_presets/save` below). User presets are merged
into the same flat `{name: [<band dicts>]}` dict as built-ins, plus a
top-level sentinel field `_user_preset_names: [<name>, ...]` so the
frontend can identify user-saved entries (for italics + delete
affordance) without a hardcoded built-in list. The leading underscore
signals "metadata, not a preset entry" — frontend iterators must skip
this key when listing dropdown options.

Per-band fields per entry: `name`, `f_min`, `f_max`, `filter_order`,
`decimation`, `exp_factor`, `model_order`, `window_length`,
`ir_length_ms`, `skip_start_ms`, `start_fade_ms`, `end_fade_ms`. See
[`MODAL_ADAPTER_GUIDE.md` § Per-band fade-in and tail fade-out](../../guides/MODAL_ADAPTER_GUIDE.md#per-band-fade-in-and-tail-fade-out)
for the per-field semantics.

#### `POST /modal/band_presets/save`

dev-esrt Phase 3 (2026-05-06). Save the supplied bands as a named user
preset (cross-project; reusable from any project under the same
`projects_base`).

Request body:
```json
{ "name": "MyBass", "bands": [<band dict>, <band dict>, ...] }
```

The `name` is validated and canonicalised:
- Stripped of leading/trailing whitespace.
- Non-empty after stripping.
- Length ≤ 64 characters.
- Not in the reserved set `{standard_4band, extended_8band, custom}`.
- Free of control / format / unassigned characters (Unicode categories
  `Cc` / `Cf` / `Cn`).

Bands list must be a non-empty list of dicts with the standard band
field shape (same as the entries returned by `GET /modal/band_presets`).

**Idempotent**: a name collision overwrites silently. The frontend
layers a confirm-replace dialog on top for UX, but the backend stays
idempotent so retries / parallel saves don't surprise.

Storage: written atomically to
`<projects_base>/.user_band_presets.json` via temp-file + `os.replace`.

Response `200`:
```json
{ "message": "saved", "name": "MyBass" }
```

Response `400` on invalid name or empty bands list:
```json
{ "error": "Preset name 'extended_8band' is reserved by the built-in preset registry. Reserved names: ['custom', 'extended_8band', 'standard_4band']." }
```

#### `DELETE /modal/band_presets/<path:name>`

dev-esrt Phase 3 (2026-05-06). Remove a named user preset. The name
is stripped of leading/trailing whitespace before lookup. Built-in
presets cannot be deleted (the user file does not contain them — DELETE
on a built-in name returns 404, the same as DELETE on any non-existent
name). Atomically rewrites the user presets file via temp-file +
`os.replace`.

Response `200`:
```json
{ "message": "deleted", "name": "MyBass" }
```

Response `404` when not found:
```json
{ "error": "preset 'Nonexistent' not found" }
```

---

### Stage 3: ESPRIT Extraction

#### `POST /modal/run_esprit`

Launch ESPRIT extraction in background. Accepts ESPRIT-specific parameters (frequency bands, model order, etc.). Results auto-persist to project dir.

Response `200`:
```json
{"task_id": "modal_esprit"}
```

---

#### `GET /modal/status`

Poll extraction progress.

Response `200`:
```json
{
  "state": "running",
  "progress": 3,
  "current_point": 3,
  "total_points": 5,
  "message": "ESPRIT scenario 40 (3/5)..."
}
```

---

#### `GET /modal/results`

Returns per-scenario extraction results (frequencies, damping ratios, merge stats).

---

### Stage 4: Mode Tracking

#### `POST /modal/run_tracking`

Run spatial mode tracking on ESPRIT results. Tracks separately for bass and treble bridges.

Request body:
```json
{
  "bridge_boundary": 28,
  "freq_tol_pct": 0.02,
  "max_gap": 3,
  "tracking_method": "nuclei_merge",
  "tracking_options": {}
}
```

`tracking_method` (optional) — one of `"nuclei_merge"` (default since dev-d773, 2026-05-05), `"sliding_window"` (legacy), or `"sequential"` (DEPRECATED). When omitted, the backend uses the `TrackingConfig` dataclass default. The frontend always sends an explicit value to avoid divergence between the dropdown selection and the backend's effective method (dev-nucl-default, 2026-05-07).

`tracking_options` (optional) — dict of overrides applied to `TrackingConfig` fields by name (e.g. `{"nm_nucleus_mac_threshold": 0.7}`). Unknown keys are ignored with a backend log warning.

Response `200`: tracked chains with stability classification and summary. Includes `nuclei_stage_chains` (Stage-1 nucleus snapshot) when `tracking_method == "nuclei_merge"` — empty list otherwise.

---

#### `GET /modal/tracking_results`

Return tracked chains with stability classification.

---

### Stage 5: Feedin Extraction

#### `POST /modal/run_feedin`

Run FFT feedin extraction on tracked mode chains. Uses response channels from mapping if not specified.

Request body:
```json
{
  "response_channels": [0, 1, 3, 4]
}
```

Response `200`: per-pitch feedin coefficients, sound coefficients, measured/interpolated pitch lists.

---

#### `GET /modal/feedin_results`

Return per-pitch feedin and sound coefficients.

---

### Stage 5b: FRF + Q Cross-check (dev-frf-q-phase01, Phase 0 + Phase 1)

The FRF (Frequency Response Function) stage was added in 2026-05-24 as
the first half of the Modal Mass + Q-factor improvement plan. It
promotes the calibration / force channel from "alignment timing" to
the input `X(f)` in a proper spectral-domain `H(f) = Y(f) / X(f)`
using the clean H1 estimator on raw per-cycle data.

See [`docs/proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md`](../../proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md)
for the full design rationale.

**Hammer-impact force window (user Q5 directive).** The force/calibration
sensor is mounted on the hammer itself (not co-located with response
sensors), so the recorded force signal contains the main impact peak
PLUS post-impact hammer bounce + recoil + ringdown. Only the main
impulse represents true input force into the structure. Before FFT,
the force is windowed to `[peak - W_pre, peak + W_post]` (default
0.5 ms + 4.5 ms = 5 ms total centred on the negative-peak impact).
Defaults are tunable per project via the `config` body field on
`POST /modal/run_frf`.

#### `POST /modal/run_frf`

Compute FRF for the requested scenarios (synchronous; per-scenario
~tens-of-ms). Bypasses `normalize_by_calibration` and works directly
on `raw_recordings/raw_*_chN.npy` so the H1 estimator is not
double-normalised (see proposal §4.2).

Request body:
```json
{
  "scenario_indices": [100, 101, 102],
  "config": {
    "force_window_pre_ms": 0.5,
    "force_window_post_ms": 4.5
  }
}
```

Both fields are optional — `scenario_indices=null` processes every
loaded scenario; `config` falls back to the module defaults.

Response `200`: same shape as `GET /modal/frf/summary`.

---

#### `GET /modal/frf/summary`

Return the project-level FRF index. Lightweight — no heavy arrays.
Safe to call before any FRF run (`available: false` then).

Response `200` (after a run):
```json
{
  "available": true,
  "stale": false,
  "computed_at": "2026-05-24T11:49:20.459820+00:00",
  "scenario_count": 1,
  "config": {
    "force_window_pre_ms": 0.5,
    "force_window_post_ms": 4.5,
    "calibration_channel": 0,
    "response_channels": [1, 2, 3, 4, 5, 6, 7]
  },
  "scenarios": [
    { "scenario_index": 100, "has_npz": true }
  ]
}
```

`stale=true` when an ESPRIT re-run or scenario re-load happened
since the last FRF run; the frontend renders a "FRF needs re-run"
badge in that state (Q8 dirty-flag flow).

---

#### `GET /modal/frf/scenario/<int:scenario_idx>`

Return one scenario's FRF arrays serialised as plain JSON lists for
the frontend. Reads back the persisted
`<project>/modal_adapter/frf/scenario_<N>.npz`.

Response `200`:
```json
{
  "scenario_index": 100,
  "frequencies": [0.0, 1.0, 2.0, "..."],
  "n_cycles_used": 120,
  "force_window": {
    "peak_sample_median": 0.0,
    "w_pre_ms": 0.5,
    "w_post_ms": 4.5
  },
  "channels": {
    "ch1": {
      "channel": 1,
      "magnitude_db": ["..."],
      "magnitude_abs": ["..."],
      "phase_deg": ["..."],
      "coherence": ["..."]
    }
  }
}
```

Coherence `γ²(f) = |G_xy|² / (G_xx · G_yy) ∈ [0, 1]` is a per-frequency
quality metric — values close to 1 mean the FRF estimate is
trustworthy at that bin, values << 1 mean the response is dominated
by input-uncorrelated noise. The frontend can gray-out / hatch
regions where coherence < 0.7.

Returns `404` if the scenario has no persisted FRF.

---

#### `DELETE /modal/frf`

Invalidate FRF for the current project: remove persisted
`frf/scenario_*.npz` + `frf/index.json` and clear the in-memory cache.
Drives the Q8 user-opt-in dirty-flag flow.

Response `200`:
```json
{
  "message": "Invalidated FRF: removed 5 files",
  "deleted_files": ["scenario_100.npz", "index.json", "..."]
}
```

---

#### `POST /modal/qc/log_decrement`

Run the Hilbert log-decrement Q cross-check against the current
tracked chains (Phase 0c). Bandpass-filters the averaged IR around
each chain's mode frequency, computes the Hilbert envelope, fits
the slope of `log(envelope)` to recover `ζ = -slope / ω_n`, and
compares `Q_logdec = 1/(2ζ)` against ESPRIT's `Q_esprit` per chain.

Request body (optional):
```json
{
  "disagreement_threshold": 0.30
}
```

`disagreement_threshold` is the relative tolerance
`|Q_logdec - Q_esprit| / Q_esprit` above which the chain is flagged
as suspicious (default 0.30 = 30%).

Response `200`:
```json
{
  "computed_at": "2026-05-24T...",
  "disagreement_threshold": 0.30,
  "chain_count": 42,
  "per_chain": {
    "0": {
      "chain_id": 0,
      "frequency_hz": 200.05,
      "Q_esprit": 100.0,
      "Q_logdec": 102.4,
      "disagreement_ratio": 0.024,
      "disagreement_flag": false,
      "reason": "ok",
      "samples_used": 4759
    }
  }
}
```

`reason` is one of: `"ok"`, `"no_damping"`, `"out_of_band"`,
`"insufficient_samples"`, `"fit_failed"`, `"bad_envelope"`,
`"no_measurements"`.

Persisted to `<project>/modal_adapter/qc/log_decrement.json`.

---

#### `GET /modal/qc/log_decrement`

Return the persisted log-decrement cross-check payload (or
`{"available": false, "per_chain": {}}` when no cross-check has run).

---

### Stage 5c: Modal Mass extraction (dev-modal-mass-p2, Phase 2)

The Modal Mass stage was added in 2026-05-24 as the second half of the
Modal Mass + Q-factor improvement plan. It consumes the FRF output of
Stage 5b plus the tracked-chain set from Stage 4 to extract per-mode
relative modal mass + mass-normalised mode shapes.

See [`docs/proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md`](../../proposals/modal-mass-q-factor-IMPROVEMENT-PLAN-2026-05-24.md)
§5.2.1 + §5.2.3 + §6 Phase 2 for the design.

**Pipeline.** Per tracked chain `n`:

1. Detect MDOF clusters by frequency proximity (user decision C —
   `|f_i - f_j| < 3 · max(BW_i, BW_j)`, cluster cap = 4 modes; chains
   beyond the cap get `fit_method = "low_density_unresolved"`).
2. For each `(scenario_i, response_channel_c)` in the chain's
   `detections`, run the SDOF Kennedy-Pancu circle-fit (singleton
   cluster) or the MDOF RFP joint LS fit (cluster of 2-4) on the
   persisted FRF `H1_ch<c>` in the band `f_n ± 3·ζ_n·f_n`. Returns
   `R_n^{i,c}` (complex) + `fit_quality ∈ [0, 1]`.
3. Build the residue tensor `R[n, a, s]` where `a` is the
   populated-grid-cell index (0..A-1, per
   `MappingConfig.point_coordinates`) and `s` is the response-channel
   axis. Missing `(actuator, channel)` entries are NaN.
4. Per chain, invert the rank-1 residue matrix via SVD under the
   **dual-unit-max convention** (`max|φ_a| = max|φ_s| = 1`): the
   leftover scale equals `1/m_n` at the joint peak by the physics, so
   `m_n = 1 / (σ_0 · max|u_0| · max|v_0|)`.
5. Reference-mode selection (user decision B): lowest-freq chain with
   `fit_quality_overall > 0.7 AND coverage >= 0.5`. Fallback: refuse
   to normalise, emit `reference_mode_warning`, raw `m_absolute` still
   stored per chain.

**Q6 gate (user decision E):** `POST /modal/run_modal_mass` requires
≥ 8 scenarios with FRF persisted; otherwise returns `422` with
`InsufficientDataError`. `GET /modal/modal_mass/summary` is
unconstrained — returns whatever was last persisted regardless of
the current scenario count.

**Units note (relative only per Q2).** H1 from Stage 5b is in
dimensionless `response_voltage / force_voltage` (raw ADC, no sensor
calibration applied). The recovered `m_n` is in
"internally-consistent voltage-ratio units" — NOT kg. The
user-meaningful output is `m_relative = m_n / m_ref`. Absolute SI
calibration is deferred per proposal §5.5.1.

#### `POST /modal/run_modal_mass`

Run the modal-mass extraction across all tracked chains. Synchronous
(per-chain fit is bounded — dozens of chains finish in a few seconds
total). Reads FRF NPZ files on disk; writes per-chain JSON +
`modal_mass/index.json`.

Request body: none (empty `{}`).

Response `200`: same shape as `GET /modal/modal_mass/summary`.

Response `422` (Q6 gate trips):
```json
{
  "error": "Modal mass requires ≥ 8 scenarios with FRF persisted; have 3. Run FRF on more scenarios first."
}
```

Other errors (`400`):

- `"No tracked chains"` — run ESPRIT + tracking first
- `"Modal mass requires a grid-layout mapping"` — line-layout project
- `"Mapping has no response channels"` — set channel roles first

---

#### `GET /modal/modal_mass/summary`

Return the project-level modal-mass summary (light meta only — no
shape arrays). Safe to call before any modal-mass run
(`available: false` then). Unconstrained by Q6 gate per user
decision E.

Response `200` (after a run):
```json
{
  "available": true,
  "stale": false,
  "computed_at": "2026-05-24T12:34:56.789012+00:00",
  "chain_count": 42,
  "scenario_count": 12,
  "reference_mode_chain_id": 4,
  "reference_mode_warning": null,
  "config": {
    "min_scenarios_for_modal_mass": 8,
    "ref_mode_fit_quality_min": 0.7,
    "ref_mode_coverage_min": 0.5,
    "mdof_cluster_cap": 4,
    "cluster_bw_mult": 3.0,
    "response_channels": [1, 2, 3, 4, 5, 6, 7],
    "actuator_count": 12
  },
  "chains": [
    {
      "chain_id": 4,
      "frequency_hz": 42.2,
      "fit_method": "mdof",
      "m_absolute": 8.87e-6,
      "m_relative": 1.0,
      "fit_quality_overall": 0.77,
      "is_reference_mode": true,
      "mass_inversion_status": "valid",
      "has_file": true
    }
  ]
}
```

`stale=true` when FRF, ESPRIT, or scenarios re-ran since the last
modal-mass run; the frontend renders a "STALE" badge on the Modal
Mass tab.

`mass_inversion_status` (dev-mstat-30b6 2026-05-26) explains the
per-chain inversion outcome — useful when `m_absolute` is `null`
because it tells the user *why*. Enum values:

| Value | Meaning |
|---|---|
| `"valid"` | Inversion succeeded; `m_absolute` is finite. |
| `"insufficient_band_width"` | Every per-`(scenario, channel)` circle/RFP fit returned `0+0j` because the chain's frequency band held < `MIN_FIT_BINS = 8` bins. Dominantly low-frequency chains. |
| `"no_full_row"` | Some residues are nonzero but no mapped actuator row had all response channels populated; `shape_inversion.py`'s row-completeness gate dropped every row. Typically high-frequency chains. |
| `"only_unmapped_full_row"` | Full rows exist, but only at scenario indices outside the actuator grid mapping (synthetic / unmapped scenario indices). Inherently rare. |

See the audit at
`docs/proposals/modal-mass-nan-investigation-2026-05-26.md` for the
decision-tree derivation and per-bucket counts on LG_p3 (386 valid /
242 insufficient_band_width / 126 no_full_row / 3
only_unmapped_full_row out of 757 chains).

**Backward compatibility:** older indices written before this commit
do not carry the field. The backend backfills on read with a best-
effort guess from `m_absolute` (finite -> `"valid"`, non-finite ->
`"insufficient_band_width"`); the next `POST /modal/run_modal_mass`
overwrites with the actually-classified value.

---

#### `GET /modal/modal_mass/mode/<int:chain_id>`

Return one chain's full modal-mass payload (residues + shapes +
mass-normalised variants + per-(scenario, channel) detail). Used by
the Modal Mass tab's per-chain drilldown.

Response `200`:
```json
{
  "chain_id": 4,
  "frequency_hz": 42.2,
  "damping_ratio": 0.0051,
  "quality_factor": 98.0,
  "coverage": 0.95,
  "fit_method": "mdof",
  "cluster_chain_ids": [3, 4, 5],
  "m_absolute": 8.87e-6,
  "m_relative": 1.0,
  "shape_actuator": [
    { "index": 0, "real": 0.92, "imag": 0.0 },
    { "index": 1, "real": 0.45, "imag": 0.01 }
  ],
  "shape_response": [
    { "index": 0, "real": 0.78, "imag": 0.02 }
  ],
  "shape_actuator_mass_normalised": [
    { "index": 0, "real": 309.4, "imag": 0.0 }
  ],
  "shape_response_mass_normalised": [
    { "index": 0, "real": 262.0, "imag": 6.7 }
  ],
  "per_scenario_residues": {
    "0": {
      "1": { "real": 0.024, "imag": 0.012, "fit_quality": 0.72 }
    }
  },
  "fit_quality_overall": 0.77,
  "is_reference_mode": true,
  "mass_inversion_status": "valid"
}
```

`mass_inversion_status` (dev-mstat-30b6 2026-05-26) — same enum as
documented above under `GET /modal/modal_mass/summary`; identical
value to the per-chain summary entry.

Both shape arrays are SPARSE — actuator cells with no valid residue
extraction are absent from the list (NOT serialised as `NaN`). The
frontend iterates the list and uses `index` to position each entry
on the actuator grid.

Returns `404` when the chain has no persisted modal-mass payload.

---

#### `DELETE /modal/modal_mass`

Invalidate modal mass for the current project: remove persisted
`modal_mass/chain_*.json` + `modal_mass/index.json` and clear the
in-memory cache. Mirrors the FRF invalidate flow.

Response `200`:
```json
{
  "message": "Invalidated modal mass: removed 42 files",
  "deleted_files": ["chain_0.json", "chain_1.json", "index.json"]
}
```

---

### Data Status surface extensions

`GET /modal/data_status` payload was extended in Phase 1 with three
new keys (additive, no breaking change), and again in Phase 2 with
two more:

| Key | Type | Meaning |
|---|---|---|
| `frf` | bool | True when at least one scenario has FRF persisted |
| `frf_stale` | bool | True when ESPRIT re-run / scenario re-load happened since the last FRF run |
| `qc_log_decrement` | bool | True when the Hilbert log-decrement cross-check has been computed for the current project |
| `modal_mass` | bool | (Phase 2) True when at least one chain has modal-mass persisted |
| `modal_mass_stale` | bool | (Phase 2) True when FRF / ESPRIT / scenarios re-ran since the last modal-mass run |

Per-chain dicts (returned by `GET /modal/tracking_results`) gained
two additive fields:

| Field | Type | Meaning |
|---|---|---|
| `quality_factor` | number \| null | `1 / (2 · damping_mean)` — surfaces the Q-factor per chain. `null` when `damping_mean` is degenerate. |
| `detections[<sc>].quality_factor` | number \| null | Per-detection Q, same formula on `damping_ratio`. |

---

### Stage 6: Channel Mapping & Visualization

#### `POST /modal/channel_mapping`

Set response channel to Pianoid sound output mapping.

Request body:
```json
{
  "channel_to_sound": {"0": 0, "1": 1, "3": 2, "4": 3}
}
```

---

#### `GET /modal/stabilization_diagram`

Return chain data for scatter plot visualization. Points: scenario x frequency, colored by stability.

---

#### `GET /modal/mode_shape/<chain_id>`

Return feedin magnitude along bridge for a single mode chain.

---

#### `GET /modal/mode_preview/<chain_id>`

Return frequency + damping for rendering decaying sinewave (uses existing `exciteMode()` pattern).

---

#### `GET /modal/grid_heatmap/<chain_id>` <a id="per-chain-grid-heatmap"></a>

Per-chain 2-D amplitude data for the grid-layout heatmap inset. Requires
`layout_type='grid'` mapping; raises 400 on line-layout projects.

Per-cell `amplitude` is the **raw measured value** for that scenario
under this chain (or `null` when no detection exists). The matrix is
returned UNCHANGED — no smoothing, no approximation, no fill. The
frontend renders smoothing as a pure-visual overlay over the unmodified
matrix (see PianoidTunner `GridHeatmapInset.jsx` for the overlay-canvas
implementation).

Optional query params — **all DEPRECATED no-ops as of round 24 (dev-maimport,
2026-05-17)**. They are accepted (parseable / valid-shape values stay
200) but produce no side effects:

- `approximation`: `"none"` (default) | `"linear"` | `"planar"`. **Round 24:
  silently ignored.** Pre-round-24 it filled empty cells via a 2-D
  planar `np.linalg.lstsq` fit; that fill is now removed because it
  injected extrapolated values into cells that had no measurement. A
  future server-side approximation feature will be its own separate
  round with a fresh API design. Echo field always reports `"none"`.
- `smoothing`: `float` (default `0.0`). **Round 24: silently ignored.**
  Pre-round-24 it applied `scipy.ndimage.gaussian_filter` server-side,
  rewriting every populated cell's amplitude with the smoothed value
  (so the frontend tooltip displayed fabricated numbers as if they
  were measurements — the round-24 user directive
  reversed this). Smoothing is now a pure-rendering concern handled
  client-side by an overlay `<canvas>` with bilinear interpolation
  that leaves the underlying matrix and tooltip untouched. Echo field
  always reports `0.0`. Garbage (non-numeric) values still 400 — the
  parameter is type-checked even though it has no effect.

Response (`200`):
```json
{
  "chain_id": 5,
  "frequency": 432.7,
  "stability": "stable",
  "grid_shape": [4, 6],
  "grid_spacing_mm": 25.0,
  "approximation": "none",
  "smoothing": 0.0,
  "cells": [
    {
      "row": 0, "col": 0,
      "scenario_index": 0,
      "x_mm": 0.0, "y_mm": 0.0,
      "amplitude": 0.83,
      "is_measured": true
    },
    ...
  ]
}
```

`is_measured` mirrors `amplitude != null` — round 24 keeps it on the
payload for the frontend to render measured-vs-empty cells distinctly
(empty cells now stay white / transparent regardless of any query
params the caller passes). Pre-round-24 callers that sent
`approximation="planar"&smoothing=2.0` will get the same response as a
no-param request — see "Round 24 deprecation" note above.

---

#### `POST /modal/chains/save`

Replace tracked chains with manually edited version. Re-indexes chain IDs 0..N-1, invalidates feedin data (must re-run feedin after edits), persists to disk. **Legacy bulk-replace path** kept for backward compatibility — prefer the granular per-op endpoints below for new code (they capture undo snapshots and recompute derived stats per chain).

Request:
```json
{
  "chains": [{ "chain_id": 0, "frequency_mean": 440.0, "damping_mean": 0.001, ... }]
}
```

Response `200`:
```json
{ "saved": 42, "data_status": { "measurements": true, "mapping": true, ... } }
```

---

#### Granular chain mutation endpoints (dev-md06)

All seven endpoints mutate `_tracked_chains` directly, push a snapshot onto the in-memory undo stack BEFORE mutating, recompute derived stats on touched chains (`frequency_mean`, `frequency_range`, `frequency_drift`, `damping_mean`, `detection_count`, `coverage`, `stability`), drop empty chains, re-index `chain_id` sequentially, invalidate feedin (`_feedin_data = None`, `_applied = False`), persist `chains.json` (carrying forward `params`, `cross_bridge_matches`, `splitter_reports` from the prior file; bumping `summary.edit_count`; recording `summary.last_action`), and bump `data_status.tracked_chains_version`. The `quality` field on each chain is NOT recomputed (requires the rotated reference shape from tracking) — consumers should treat it as stale-after-edit until the next `run_tracking`.

All responses include `chains` (the canonical post-mutation list) and `data_status`. Op-specific fields are noted per endpoint.

##### `POST /modal/chains/merge`

Merge source chains into target chain. Detection conflicts at shared scenarios: source-order wins (later sources overwrite earlier; target's existing detection is overwritten by any source). Source chains are deleted; remaining chains are re-indexed.

Request: `{"target_chain_id": int, "source_chain_ids": [int, ...]}`

Response: `{"merged_chain_id": int, "chains": [...], "data_status": {...}}` — `merged_chain_id` is the merged target's NEW (post-re-index) chain_id.

Errors: `400` on empty `source_chain_ids`, target in source list, or unknown id.

##### `POST /modal/chains/add_point`

Add a single detection to a chain at a given scenario. Existing detection at that scenario on this chain is overwritten. Cross-chain duplicate validation (same scenario+frequency on a different chain) is the frontend's responsibility — backend accepts any detection unconditionally.

Request: `{"chain_id": int, "scenario_index": int, "detection": {"frequency": float, "damping_ratio": float?, "amplitude": float?, "shape": [...]?, "mode_shape": [[r,i], ...]?}}`

Response: `{"chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/remove_point`

Remove a single detection from a chain. If this empties the chain, the chain itself is deleted. Silently no-op if the detection is not present (no error, no version bump, no undo snapshot).

Request: `{"chain_id": int, "scenario_index": int}`

Response: `{"removed_chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/create`

Create a new chain from a list of points. The new chain's id is assigned during re-index (it ends up at position N).

Request: `{"points": [{"scenario_index": int, "frequency": float, "damping_ratio": float?, ...}, ...]}`

Response: `{"new_chain_id": int, "chains": [...], "data_status": {...}}`

Errors: `400` on empty `points` list or any point missing `scenario_index` / `frequency`.

##### `POST /modal/chains/break`

Split a chain at a given scenario into two chains. Detections at scenario ≤ split point stay with the original chain id; detections after the split form a NEW chain (assigned during re-index). Errors if the split would empty either side (i.e. split at the first or last scenario).

Request: `{"chain_id": int, "scenario_index": int}`

Response: `{"left_chain_id": int, "right_chain_id": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/dissolve`

Remove all detections inside a (frequency, scenario) box. Empty chains after dissolution are deleted.

Request: `{"freq_min": float, "freq_max": float, "scenario_min": int|null, "scenario_max": int|null}` — `scenario_min`/`max` of `null` mean unbounded on that side.

Response: `{"dissolve_warning": bool, "chains": [...], "data_status": {...}}` — `dissolve_warning` is `true` if any chain lost > 50% of its detections.

##### `POST /modal/chains/delete`

Delete one or more entire chains by id. Idempotent — silently ignores ids that aren't present (no error). If no ids actually delete, returns without bumping version or capturing an undo snapshot.

Request: `{"chain_ids": [int, ...]}`

Response: `{"deleted": int, "chains": [...], "data_status": {...}}`

##### `POST /modal/chains/undo` and `POST /modal/chains/redo`

Step backward / forward through the in-memory chain edit history. Undo stack capped at 30 entries. Each mutation endpoint pushes a snapshot (and clears the redo stack); undo pops from undo + pushes current to redo; redo pops from redo + pushes current to undo. Both re-persist `chains.json` and bump `tracked_chains_version`.

Snapshots are dropped on `run_tracking` (chain set rebuilt — old IDs no longer match), on project switch (new chain set), and on `reset`. They do NOT survive server restart.

Request: empty body (`{}` accepted, also no body).

Response: `{"chains": [...], "data_status": {...}}`.

Errors: `400` `{"error": "nothing to undo"}` (or "nothing to redo") when the corresponding stack is empty. Frontend should gate the toolbar buttons on `data_status.chain_undo_available` / `chain_redo_available` so users can't trigger this.

---

#### `data_status` fields added by dev-md06

The `data_status` payload (returned in every chain-mutation response, `/modal/project_state`, `/modal/data_status`) includes:

- `chain_undo_available: bool` — true iff the in-memory undo snapshot stack is non-empty.
- `chain_redo_available: bool` — true iff the in-memory redo snapshot stack is non-empty.
- `tracked_chains_version: int` — monotonic counter, bumped on every backend change to `_tracked_chains` (run_tracking, project load, every chain mutation, undo, redo, reset). Frontend cache effects (e.g. `GridHeatmapInset` fetch useEffect) include this in their deps so they re-fetch automatically when the backend chain set changes — fixes the post-merge stale-heatmap class of bugs (dev-md06 Bug A) where the cache key on the heatmap (chain_id) didn't move even though the backend chain contents did.

---

### Stage 7: Apply & Persistence

#### `POST /modal/apply_to_preset` — **served by the main backend (port 5000)**

Apply extracted modes to the active Pianoid preset. Uses FFT feedin path when feedin data is available.

This is the one `/modal/*` route that runs on the **main backend** (port 5000), not on the modal adapter server (port 5001). It must mutate the running `Pianoid` engine, which lives only in the main server process. The modal adapter server rejects this route with `503 ModalAdapterOnlyError` (see F9 above) — external callers must POST to the main server instead.

Implementation: the main-server route rehydrates a fresh `ModalAdapter` from the project directory on disk (auto-persisted by the 5001 server on every mutation), then calls `adapter.apply_to_preset(pianoid, selected_chains, merge)`.

Request body:
```json
{
  "project_name": "belarus_78",
  "selected_chains": [0, 1, 2, 5, 8],
  "merge": false
}
```

- `project_name` (required): the adapter's on-disk project to apply. Usually the frontend's `currentProject`.
- `selected_chains` (optional, default `[]` = all): chain IDs to inject.
- `merge` (optional, default `false`): if `true`, merges with existing modes; if `false`, replaces.

Responses:
- `200`: `{"message": "Applied N modes with FFT feedin"}`
- `400`: missing `project_name`
- `404`: project not found on disk
- `409`: no preset loaded, or project has no tracking/feedin data to apply
- `500`: unexpected error

---

#### `POST /modal/projects/<name>/export_text` (dev-6c54c87f, extended dev-camp 2026-05-07, dev-mmexp-5561 2026-05-26)

Write the 5 RoomResponse-format text files (`Ci_coef_cos.txt`, `omega_coef.txt`,
`Q_coeff_Q.txt`, `Q_coeff_E.txt`, `decka_coeff.txt`) plus a
`stitched_results.json` sidecar, a `mode_amplitudes.csv`
(per-(mode, scenario) complex amplitudes), AND -- when the project has
persisted modal-mass results -- a `relative_modal_mass.txt` (per-chain
relative modal mass reference) to disk. This is the runtime port of the
`Merge_res_New.py` Stage-2 generator from the RoomResponse repository,
adapted to consume already-aggregated mode chains directly from the Modal
Adapter's `_tracked_chains`.

The named project must be the currently-open project — the export reads
the in-memory `_tracked_chains` and `_mapping`, so opening a different
project first is required (`POST /modal/projects/<name>/open`).

Request body (all fields optional):

```json
{
  "output_dir": "D:/some/path",
  "selected_chains": [0, 2, 5, 7]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `output_dir` | `{project}/modal_adapter/export_text/` | Absolute path. Created if missing. |
| `selected_chains` | `null` (= all chains) | List of chain_ids to export. Pass the user's curated `selectedChains` set to match the Apply panel's behaviour, or omit to export all. |

200 response body:

```json
{
  "message": "Exported 7 text files to D:/.../export_text (12 modes + 116 placeholders)",
  "output_dir": "D:/.../modal_adapter/export_text",
  "files": {
    "Ci_coef_cos.txt": "D:/.../Ci_coef_cos.txt",
    "omega_coef.txt":  "D:/.../omega_coef.txt",
    "Q_coeff_Q.txt":   "D:/.../Q_coeff_Q.txt",
    "Q_coeff_E.txt":   "D:/.../Q_coeff_E.txt",
    "decka_coeff.txt": "D:/.../decka_coeff.txt",
    "stitched_results.json": "D:/.../stitched_results.json",
    "mode_amplitudes.csv": "D:/.../mode_amplitudes.csv",
    "relative_modal_mass.txt": "D:/.../relative_modal_mass.txt"
  },
  "n_modes_exported": 12,
  "n_modes_padded":   116,
  "approximation":    "linear"
}
```

`approximation` is either `"linear"` (line layout — uses `scipy.interpolate.interp1d`)
or `"planar"` (grid layout — uses `np.linalg.lstsq` on `(x, y, value)` tuples
to fit `z = a*x + b*y + c`). The choice is auto-determined by the project's
`mapping.layout_type`.

`mode_amplitudes.csv` (dev-camp 2026-05-07) is an additive companion to
the 5 fixed-name `.txt` files. It holds the per-(mode, scenario) complex
amplitudes -- one row per chain, columns
`0_re, 0_im, 1_re, 1_im, ..., (N-1)_re, (N-1)_im` where `N` is the
number of scenarios. Cells with no detection write `0.000000, 0.000000`.
Only the effective modes are written (no placeholder rows). See
[`MODAL_ADAPTER_GUIDE.md` — Complex amplitudes CSV](../../guides/MODAL_ADAPTER_GUIDE.md#export-to-text-files-dev-6c54c87f).

`relative_modal_mass.txt` (dev-mmexp-5561 2026-05-26; dev-mmexp2-f492
2026-05-26 added export-set filter + NaN drop; dev-mstat-30b6 2026-05-26
added `mass_inversion_status` column) is the per-chain
relative-modal-mass reference. Tab-separated, with `#`-prefixed header
lines (compatible with `np.loadtxt(comments="#")` round-trips) carrying
the reference chain, project metadata, column names, and the filter
book-keeping (`rows_after_filter`, `rows_written`). Rows are
**sorted by frequency ascending** (NOT chain_id). Columns (in order):
`chain_id`, `frequency_hz`, `m_relative`, `m_absolute`,
`fit_quality_overall`, `is_reference`, `mass_inversion_status`.

The trailing `mass_inversion_status` column is a string enum (one of
`valid` / `insufficient_band_width` / `no_full_row` /
`only_unmapped_full_row`); numpy round-trip consumers should pass
`usecols=range(0, 6)` to skip it. In practice every emitted row has
`status = valid` because the NaN-drop filter (see below) removes every
non-valid candidate — the column exists for schema stability if the
NaN drop is ever relaxed.

**Row filtering** (matches the rest of the bundle):

- **Export-set filter** — when `selected_chains` is supplied in the
  request body, the file is filtered to those chain_ids only. This is
  the same filter `build_export_payload` applies to `omega_coef.txt`,
  `Q_coeff_*.txt`, `decka_coeff.txt`, `Ci_coef_cos.txt`, and
  `mode_amplitudes.csv`, so all bundle files cover the same modes.
  Omit `selected_chains` (or pass `null`) to include all chains from
  the modal-mass summary.
- **NaN drop** — rows where `m_relative` is non-finite (`None` /
  `NaN` / `inf` — i.e. the modal-mass fit failed for that chain) are
  dropped after the export-set filter. The header records the row
  count both before (`rows_after_filter`) and after (`rows_written`)
  the drop so a reader can audit how many chains were skipped.

The file is **silently omitted** when the project has no persisted
modal-mass results (no `modal_adapter/modal_mass/index.json` on disk).
The 5 fixed-name `.txt` files + sidecar + `mode_amplitudes.csv` are
always written regardless. To populate modal mass first, run
`POST /modal/run_modal_mass` (the Q6 gate requires ≥8 scenarios with
FRF persisted). Reads from `modal_adapter/modal_mass/index.json` in
the project directory — same source as
`GET /modal/modal_mass/summary`.

Error responses:

| Status | Cause |
|--------|-------|
| `400` | `name` is not the currently-open project |
| `400` | `selected_chains` is not a list of integers |
| `400` (RuntimeError → 409) | No tracked chains (run mode tracking first), or no mapping set |
| `500` | Unexpected error |

See [`MODAL_ADAPTER_GUIDE.md` — Export to Text Files](../../guides/MODAL_ADAPTER_GUIDE.md#export-to-text-files-dev-6c54c87f) for the full file format spec, the linear-vs-planar approximation choice, and the UI workflow.

---

#### `POST /modal/projects/<name>/tracking_report` (dev-f116)

Render a per-mode tracking-results **PDF** for the export set and write
it to disk. One page per mode (frequency range, damping, MAC, stability =
scenario count, heatmap, mode-shape chart) plus a summary cover page.
Read-only — does not modify project state.

The named project must be the currently-open project (the report reads
the in-memory `_tracked_chains` and `_mapping`).

Request body (all fields optional):

```json
{
  "selected_chains": [0, 2, 5, 7],
  "smoothing": 1.5,
  "output_dir": "D:/some/path"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `selected_chains` | `null` (= all chains) | The export set — list of chain_ids to include. Pass the frontend's curated `exportSelection` set. |
| `smoothing` | `1.5` | Heatmap blend strength (0–2). Replicates the on-screen `GridHeatmapInset` pairwise-border blend (`σ * cellWidth / 4` stripe half-width); the measured matrix is not mutated. |
| `output_dir` | the **project directory root** (`{projects_base}/{name}/`) | Absolute path. Created if missing. The PDF is named `{name}_tracking_report.pdf`. |

200 response body:

```json
{
  "message": "Tracking report written for 8 modes",
  "pdf_path": "D:/modal_projects/PlyWood_p2/PlyWood_p2_tracking_report.pdf",
  "n_modes": 8,
  "layout_type": "grid",
  "smoothing": 1.5
}
```

Per-mode fields are read straight from the serialized chain dict:
frequency range = `frequency_range`, damping = `damping_mean`, MAC =
`quality.shape_consistency`, stability = `detection_count`. The heatmap
is the per-chain grid amplitude (grid layout) or a per-scenario amplitude
strip (line layout); the shape chart is the per-detection `shape`
spatial pattern. Rendered with matplotlib `PdfPages` (no new dependency).

Error responses:

| Status | Cause |
|--------|-------|
| `400` | `name` is not the currently-open project |
| `400` | `selected_chains` is not a list of integers, or `smoothing` is not a number |
| `400` | No tracked chains (run mode tracking first), no mapping set, or the export set selects no existing chains |
| `500` | Unexpected error |

See [`MODAL_ADAPTER_GUIDE.md` — Tracking Report (PDF)](../../guides/MODAL_ADAPTER_GUIDE.md#tracking-report-pdf-dev-f116) for the report layout and the heatmap-smoothing parity note.

---

#### `POST /modal/cancel`

Cancel a running ESPRIT extraction.

---

#### `POST /modal/set_project_dir`

Set persistence directory. Creates subdirs for auto-saving intermediate results.

Request body:
```json
{"path": "D:/projects/my_piano"}
```

---

#### `GET /modal/load_intermediate/<stage>`

Load saved intermediate results for a stage. Stage: `esprit`, `tracking`, `feedin`, `mapping`.

---

### Project Management

#### `GET /modal/projects`

Returns the list of projects, current active project, and the projects base directory.

Response `200`:
```json
{
  "projects": ["piano_A", "piano_B"],
  "current_project": "piano_A",
  "projects_base": "D:\\projects"
}
```

---

#### `POST /modal/projects/create`

Create a v1 project. Optionally copy measurements from an existing source.

Request body:
```json
{
  "name": "piano_C",
  "measurement_source": "piano_A"
}
```

- `measurement_source` (optional): name of existing project to copy measurements from

> **v2 create.** New work uses `POST /modal/projects` (body `{name, measurement_id, ...}`),
> which links the Project to a first-class Measurement and snapshots its setup (N5).
> See [Measurement Collection Endpoints § v2 Project endpoints](#measurement-collection-endpoints-port-5001--v2-measurement-entity).

---

#### `POST /modal/projects/open`

Open an existing project. Loads measurements and any saved intermediate data (ESPRIT results, tracking, feedin).

Request body:
```json
{
  "name": "piano_A"
}
```

---

#### `POST /modal/projects/copy` — RETIRED (410 Gone, Phase 2c)

Hard-cut per the Measurement-entity proposal (N8). The route returns the
standard `410 Gone` body (`{error:"endpoint_retired", retired_at:"v2",
phase:"Phase 2c", replacement:"/modal/projects/<old>/branch", doc:...}`).
The Copy From flow is replaced by **branching**: a sibling Project that
points at the same parent Measurement and takes a fresh setup snapshot —
no measurement data is duplicated on disk.

```
POST /modal/projects/<old>/branch   { "new_name": "...", "inherit_band_config": true? }
```

The underlying `ModalAdapter.copy_project()` Python method remains for
direct callers (tests, scripts) until a follow-on session retires it; only
the HTTP surface is gone. The frontend `useProjectCRUD.copyProject` helper
is now a throwing stub. See
[MODAL_COLLECTION.md § /modal/projects/copy retired](MODAL_COLLECTION.md#modalprojectscopy--create_from_zip-retired-n8).

---

#### `POST /modal/projects/delete`

Delete a project and its data.

Request body:
```json
{
  "name": "piano_C"
}
```

---

#### `POST /modal/projects/add_measurements`

Add measurement files to the current project.

---

#### `POST /modal/projects/set_base`

Set the base directory for all projects.

Request body:
```json
{
  "path": "D:\\projects"
}
```

---

### Project Export / Import

#### `GET /modal/projects/export?name=<name>`

Streams a `.pianoid-project` zip archive as a download. The archive contains `manifest.json` (format version, checksum, hostname), sanitised `project.json` (measurement_source replaced with `"(exported)"`), and all project data (measurements, modal_adapter intermediate results).

Response: binary zip file with `Content-Disposition: attachment; filename="<name>.pianoid-project"`.

---

#### `GET /modal/projects/export_info?name=<name>`

Preview info before exporting. Returns size and stage completeness.

Response `200`:
```json
{
  "name": "piano_A",
  "total_size_bytes": 73400320,
  "total_size_mb": 70.0,
  "num_scenarios": 78,
  "stages": {
    "measurements": true,
    "esprit": true,
    "tracking": true,
    "feedin": false
  }
}
```

---

#### `POST /modal/projects/import`

Import a `.pianoid-project` zip archive via multipart file upload. Validates archive structure (must contain `manifest.json` + `project.json`), checks format version, extracts into `projects_base`. Resolves name conflicts by appending `_1`, `_2`, etc.

Form fields: `file` (required, the zip archive), `name` (optional, override project name).

Response `200`:
```json
{
  "name": "piano_A",
  "path": "D:\\projects\\piano_A",
  "imported_from": "STUDIO-PC",
  "renamed": false
}
```

If name conflict was resolved, `renamed` is `true` and `name` contains the suffixed name.

---

### Effective Signal Length QC (dev-qc01)

Per-scenario per-channel reproducibility check (split-half jackknife).
The averager runs this every time it computes a canonical mean — see
[`MODAL_ADAPTER_GUIDE.md` § Effective Signal Length QC](../../guides/MODAL_ADAPTER_GUIDE.md#effective-signal-length-qc-split-half-jackknife)
for algorithm details.

#### `GET /modal/projects/<name>/effective_signal_length`

Returns the QC roll-up + per-scenario per-channel detail for one project.

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "summary": {
    "n_scenarios_total": 30,
    "n_scenarios_with_qc": 30,
    "n_scenarios_without_qc": 0,
    "global_min_t_eff_ms": 880.0,
    "per_channel_min_t_eff_ms": {"1": 905.2, "2": 880.0, "3": 920.5},
    "per_scenario_min_t_eff_ms": {
      "PlyWood-Scenario0-Take1": 905.2,
      "PlyWood-Scenario1-Take1": 880.0
    },
    "threshold": 0.1,
    "envelope_method": "hilbert"
  },
  "per_scenario": {
    "PlyWood-Scenario0-Take1": { /* full effective_signal_length.json content */ }
  }
}
```

`summary` is `null` when no QC files exist anywhere under the project's
measurement source (e.g. legacy projects whose `averaged_responses/`
predate dev-qc01). `404` when the named project doesn't exist.

#### `POST /modal/projects/<name>/effective_signal_length`

Recomputes QC for one project. Re-runs the canonical averager on each
target scenario with `force=True` — the QC step rewrites
`effective_signal_length.json`. Raw recordings must still be on disk.

Body (all optional):
```json
{
  "scenarios": ["PlyWood-Scenario3-Take1", "PlyWood-Scenario7-Take1"],
  "qc_threshold": 0.1
}
```

- `scenarios`: list of scenario folder names. Without it, every
  scenario the project has access to is recomputed.
- `qc_threshold` (dev-qc02): env_diff/env_signal ratio gate, must be in
  `(0, 1)`. Default 0.1. Persisted into each scenario's
  `effective_signal_length.json` so the next reader knows which
  threshold the QC was computed with. Useful for sweeping the threshold
  to find a setting suited to the project's noise characteristics.

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "summary": { /* as above */ },
  "per_scenario": { /* as above */ },
  "recomputed_scenarios": 2,
  "averaging_summary": {
    "computed": 2,
    "qc_computed": 2,
    "qc_min_t_eff_ms_per_scenario": {"PlyWood-Scenario3-Take1": 905.2}
  }
}
```

`404` when project doesn't exist; `400` when `scenarios` is not a list
or `qc_threshold` is not numeric / out of range.

#### `GET /modal/projects/<name>/qc_curves`

Return time-domain QC curves for one (project, scenario, channel)
tuple — backs the interactive
[`QCVisualizationPanel`](../../guides/MODAL_ADAPTER_GUIDE.md#interactive-qc-inspection-panel-dev-3151-2026-05-06)
panel (dev-3151, 2026-05-06).

Re-runs the canonical pipeline (extract → validate → align →
normalize → pool cycles → split-half → average each half → compute
envelopes) on the scenario's `raw_recordings/` and returns the
arrays the panel needs to render: `signal_a`, `signal_b`,
`signal_full`, `signal_diff`, `env_signal`, `env_diff`, `ratio` —
plus T_eff at the requested threshold and ratio-at-end statistics.

The persisted `effective_signal_length.json` is NOT modified — this
is a read-only introspection. The persisted T_eff (computed at
averaging time) remains the source of truth for the project-level
warning surface (EspritConfig).

Per-process LRU cache on `(project, scenario)` (the slow part is
the cycle pool; the per-channel split + average + envelope is
~50 ms on cached pool). Cap 16 entries.

**Query params:**

- `scenario` (required, string): scenario folder name
  (e.g. `"PlyWood-Scenario3-Take1"`).
- `channel` (required, int): response channel index. Must NOT be
  the calibration channel.
- `qc_threshold` (optional, float in `(0, 1)`): override the
  env_diff/env_signal ratio gate ONLY for the server-side
  `t_eff_ms` field in the response payload. The panel mutates
  threshold client-side via its own recompute against the returned
  `ratio` array, so most calls omit this. Default = the module
  default (0.1).

Response `200`:
```json
{
  "project_name": "PlyWoodTake1",
  "scenario_name": "PlyWood-Scenario3-Take1",
  "channel": 1,
  "sample_rate": 48000,
  "qc_threshold": 0.1,
  "smoothing_ms": 5.0,
  "sustained_ms": 10.0,
  "envelope_method": "hilbert",
  "cal_ch": 0,
  "response_channels": [1, 2, 3],
  "n_cycles_total": 90,
  "n_cycles_half_a": 45,
  "n_cycles_half_b": 45,
  "split_seed": 12345,
  "signal_length_samples": 48000,
  "signal_length_ms": 1000.0,
  "time_ms":     [0.0, 0.0208, 0.0417, "..."],
  "signal_a":    ["..."],
  "signal_b":    ["..."],
  "signal_full": ["..."],
  "signal_diff": ["..."],
  "env_signal":  ["..."],
  "env_diff":    ["..."],
  "ratio":       ["..."],
  "t_eff_ms": 87.4,
  "t_eff_samples": 4195,
  "ratio_at_end": 0.234,
  "ratio_end_window_ms": 50.0,
  "ratio_end_median": 0.221
}
```

All time-series arrays have length `signal_length_samples` (T).
The `ratio` field is the safe-divided `env_diff / max(env_signal,
1e-12)`. `t_eff_ms` is `null` when no sustained crossing exists at
the requested threshold (the signal is reproducible across the full
duration). `ratio_at_end` is the very last sample's ratio;
`ratio_end_median` is the median over the trailing 50 ms — more
robust against single-sample edge effects.

**Errors:**

- `400` — missing `scenario` or `channel` query param; non-integer
  channel; channel is the calibration channel; channel is not in
  the scenario's response-channels set; non-numeric or
  out-of-range `qc_threshold`.
- `404` — project does not exist; scenario folder not found under
  the project's measurement source; scenario lacks `raw_recordings/`;
  too few cycles surviving validation/alignment for split-half
  (< 4 cycles).
- `500` — canonical pipeline crash (RoomResponse not available,
  unexpected error).

**Payload size:** ~8 MB raw on a typical 48000-sample (1 s) signal
× 8 numeric series × 8 bytes per float64 ≈ ~3 MB gzipped. ECharts
handles this without issue; the LRU cache makes channel switches
~280 ms (vs ~670 ms cold).

---

### Measurement Collection Endpoints (port 5001) — v2 Measurement entity

> **Canonical doc:** [MODAL_COLLECTION.md](MODAL_COLLECTION.md) holds the full
> architecture, the migration CLI, the import endpoints, the setup-stitching
> table, and per-route curl examples. This section is the endpoint quick-reference.

The Modal Adapter **Measurement** is the first-class acquisition entity (raw
recordings + `setup/*` config), separate from the analysis-side **Project**.
A Project snapshots its parent Measurement's setup at branch time (N5) and is
never auto-deleted when a Project is deleted (N6 — explicit delete only). Per
the proposal's N8 hard cutover the **v1 `/modal/collect/*` surface is retired
to `410 Gone`** (Phase 2a); the only survivor is the global
`GET /modal/measurements/active_session` probe.

#### Status-code contract

| Code | When |
|------|------|
| `409` | duplicate `measurement_id` on create (N1); Measurement still referenced by ≥1 Project on delete (N6, body `{linked_projects:[...]}`); another acquisition already in flight; rename target name taken |
| `410` | any retired v1 `/modal/collect/*` path; retired `/modal/projects/copy` + `/create_from_zip` (body `{error:"endpoint_retired", replacement, doc}`) |
| `422` | invalid `measurement_id` slug; STRICT import-compat mismatch |
| `423` | write to `setup/*` while `locks/acquisition.lock` exists (N4); rename of a locked / currently-open Measurement |
| `502` | Pause Pianoid failed on Setup Test / collect start (audio device never opened) |
| `503` | SDL3 / measurement stack unavailable (devices, collect start) |

#### Lifecycle endpoints (Phase 1)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/modal/measurements` | Create. Body `{measurement_id, sample_rate?, audio_config?, impulse_config?, series_config?, mapping_config?, calibration_criteria?}`. 201 + summary. 409 dup (N1), 422 slug |
| GET  | `/modal/measurements` | List summaries (+ `mtime`, `linked_projects_count`/`linked_projects` for the manage dialog) |
| GET  | `/modal/measurements/<id>` | Full manifest + inline `setup/*` + scenarios list. 404 if missing |
| PATCH | `/modal/measurements/<id>/{audio,impulse,series,mapping}_config` | Update one setup file. 423 if locked (N4). Response carries the full re-read body under the long section key (round-10 fix) |
| PATCH | `/modal/measurements/<id>/calibration_criteria` | Always allowed even when locked (analysis-time gate, N4) |
| POST | `/modal/measurements/<id>/unlock` | Manual unlock-with-warning (N4). Body `{confirm:true}` required (400 without). Lock re-fires on next successful scenario |
| POST | `/modal/measurements/<id>/rename` | Atomic folder rename + every referencing Project's `measurement_id`/`measurement_path`. 423 locked/open, 409 name taken, 500 rolled-back |
| DELETE | `/modal/measurements/<id>` | Delete. 409 `{linked_projects:[...]}` if any Project references it (N6, no force flag) |

#### Setup Test (Phase 2a)

`POST /modal/measurements/<id>/setup_test` runs ONE calibration impulse cycle
(`SetupTestEngine`): pause synth → record → validate every channel against
`setup/calibration_criteria.json` → resume synth → overwrite
`setup_test/latest.{json,wav}` (N3, single-latest). `GET` returns the latest
report (404 if never run — no history endpoint). Report:

```json
{
  "schema_version": 1, "tested_at": "2026-05-11T15:00:00Z",
  "overall": "pass",
  "results": [{"criterion_id": "calibration_correlation_min", "channel": "calibration",
               "measured": 0.92, "threshold": 0.85, "verdict": "pass", "fail_action": "fail"}],
  "recording_path": "setup_test/latest.wav", "error": null
}
```

`overall = fail` if any `fail_action:"fail"` criterion fails, else `warn` if
any `fail_action:"warn"` fails, else `pass`. 502 on pause failure, 500 on
engine crash (report still persisted so the UI sees a fail surface).

#### Per-Measurement collect family (Phase 2c)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/modal/measurements/<id>/collect/start` | Body `{scenario_number, description?, computer?, room?, recorder_config_overrides?}`. Stitches `setup/*` → legacy recorder cfg (`_build_recorder_config_from_measurement`); caller overrides win. Each configured exciter is recorded alone as scenario `scenario_number + k` (one ASIO session per measurement on `:5000`). 409 if a session is in flight; 503 `asio_unavailable` without an ASIO host. First successful scenario auto-locks (N4) |
| GET  | `/modal/measurements/<id>/collect/status` | Per-Measurement snapshot incl. `messages` ring buffer (Q8). Cross-Measurement → `{phase:"idle"}` |
| POST | `/modal/measurements/<id>/collect/cancel` | Cancel in-flight. Cross-Measurement → 409 with active id |
| GET  | `/modal/measurements/<id>/collect/results/<sid>` | Completed scenario result. Cross-Measurement → 404 |
| GET  | `/modal/measurements/<id>/devices` | ASIO channel tables (proxy of `:5000` `GET /audio/devices`: driver, rate, buffer, latencies, `inputs` / `outputs` by name) + `current` = the Measurement's exciters / receivers / loopback (+ `legacy_sdl`); 503 `asio_unavailable` without an ASIO host (dev-4284) |
| GET  | `/modal/measurements/devices` | Unscoped alias (Create-Measurement flow, no id yet); `current` = null |
| GET  | `/modal/measurements/active_session` | Global "any session in flight?" probe — `{measurement_id, session_id, phase, progress_pct, messages, ...}` or `{phase:"idle"}`. Sole v1 survivor |

#### v2 Project endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/modal/projects` | Create from a Measurement. Body `{name, measurement_id, band_config?, async?}` (or `?measurement=<id>`). Snapshots parent setup (N5). 404 unknown measurement, 409 name collision. `async:true` → 202 `{operation_id, status_url}` |
| POST | `/modal/projects/<old>/branch` | Branch a sibling Project off the same Measurement. Body `{new_name, inherit_band_config?}`. Fresh snapshot of the parent's CURRENT setup. 409 if source is v1 (no `measurement_id`) |
| POST | `/modal/projects/copy`, `/modal/projects/create_from_zip` | RETIRED 410 Gone (Phase 2c) → use `/branch` / `POST /modal/projects` |

#### Migration (v1 → v2)

`python -m pianoid_middleware.modal_adapter.migrate_to_measurement_entity --mode
{dry-run|apply|verify|rollback}` upgrades each v1 Project into a (Measurement +
thin Project) pair: writes a rollback tarball, upgrades / reuses the Measurement
folder, rewrites `project.json` to `schema_version:2` (adds `measurement_id`,
`measurement_path`, `measurement_snapshot`, `averaging`), and seals the
Measurement (`reason:"migration_v1_to_v2"`). Idempotent (`already_v2` skipped);
refuses v1 projects with no / missing / external `measurement_source`. See
[MODAL_COLLECTION.md § Migration Script](MODAL_COLLECTION.md#migration-script).

---

## Error Handling Patterns

| HTTP Code | Meaning |
|-----------|---------|
| 200 | Success |
| 400 | Bad request: missing or invalid parameters, pianoid not initialized |
| 404 | Resource not found (e.g. MIDI file) |
| 416 | Parameter parsing error or internal module error |
| 499 | Action executed (returned by `/get_chart_test` for action types) |
| 500 | Unexpected server error |

All error responses include a `message` or `error` field with a description. Internal module errors include a Python traceback in the response body.
