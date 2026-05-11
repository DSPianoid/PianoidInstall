# Modal Adapter — Measurement Entity Refactor (Option B)

> **STATUS — DECISIONS LOCKED 2026-05-10.** Authoritative spec for the Modal
> Adapter Measurement-entity refactor. All 16 design decisions (Q1–Q8 + N1–N8)
> have been resolved by the user and baked into the body of this document.
> Phase 0 ready to start on user approval.

**Date:** 2026-05-10 (decisions locked 2026-05-10)
**Status:** Authoritative spec, NOT IMPLEMENTED. Multi-phase, ~5–6 week wall budget.
**Author:** /analyse pass (orchestrator-spawned read-only investigation), decisions baked in by /dev (dev-propspec, 2026-05-10).

---

## 1. Executive Summary

The Modal Adapter today conflates two life-cycle concerns inside a single
**Project** entity:

1. **Acquisition concerns** — what was physically measured (channel mapping,
   bridge layout, which audio device, what impulse shape, how many pulses
   per cycle, raw `.wav` recordings).
2. **Analysis concerns** — what the operator wants to *do* with that
   measurement (ESPRIT band split, averaging window, mode-tracking method,
   feedin extraction, preset injection).

Today, both sets of concerns live inside the same `project.json` and the
same `{project_dir}/...` tree, so any "what if I re-extract with different
ESPRIT bands" experiment forces the user to clone the whole project (raw
recordings included). The **Copy From** flow exists precisely to mitigate
this, but it remains a workaround — the underlying entity model is wrong.

This proposal promotes **Measurement** to a first-class entity. A
Measurement is created once at collection time and is then immutable in
its acquisition-side configuration. One or more **Projects** reference a
single parent Measurement and own only the analysis configuration. The
Copy From flow becomes obsolete (replaced by "create another Project from
the same Measurement"); branching ESPRIT experiments becomes the natural
operation; the raw audio data is stored exactly once on disk.

**Naming and identity (N1).** Measurement names are unique IDs. Duplicate
names are blocked at creation time — there is no display-ambiguity case to
handle in the UI. The display name IS the identity.

**Cross-machine portability (N2).** Each Project stores BOTH
`measurement_id` AND an absolute `measurement_path`. Resolution at open
time prefers `$PIANOID_MEASUREMENTS_DIR/{measurement_id}/`, falling back
to the absolute path. A Project moved to another machine "just works" as
long as either its env-var-rooted Measurement folder exists OR the
absolute path is reachable.

**Snapshot semantics (N5).** When a Project is created from a Measurement,
the Project SNAPSHOTS the Measurement's setup at branch-time. Subsequent
edits to the parent Measurement (after unlock) do NOT affect existing
Projects — only newly-branched ones see the edited setup. Existing
Projects remain frozen against their snapshot. This eliminates the entire
class of "the Measurement got re-edited and my ESPRIT cache is now lying
to me" footguns.

**Lock semantics (N4).** A Measurement auto-locks after the FIRST scenario
is recorded. From that point on, `setup/*` is sealed and any further
edits require the explicit "Unlock with warning" button (always available
for advanced cases — re-takes, calibration sweeps). The criteria editor
remains live even when locked (it's an analysis-time gate, not an
acquisition input).

**Deletion policy (N6).** Measurements are NEVER auto-deleted on Project
delete. The Project Delete dialog has no "also delete Measurement"
checkbox. Removing a Measurement requires an explicit action from the
Measurement-list view. This protects raw recordings from accidental
cascading loss.

**Recording mode scope (N7).** `recording_mode` is a per-Measurement
setting only — every scenario in a Measurement is collected in the same
mode (standard or calibration). Mixed-mode Measurements are not
supported; collect a separate Measurement for the calibration sweep.

Acquisition is gated by a single standardised **Setup Test** (Q4 + Q5) —
one calibration impulse run that exercises the audio device(s), validates
the input on every receiver, and reports pass / warn / fail against a
single **Calibration Quality Criteria** rule set. The same Setup Test
component (`<SetupTest>`) is shared verbatim across three UI surfaces
(Audio Devices section, Impulse properties section, Collection pre-flight
check). Each new run overwrites the previous result — only the latest
Setup Test artefact is retained per Measurement (N3). The temp lives at
`<measurement>/setup_test/latest.{json,wav}`.

The collection backend is moved fully in-tree (Q6): the historical
`RoomResponse/` sibling repo is no longer consulted at runtime, the C++
`sdl_audio_core` source moves into `PianoidCore/` as a sub-directory and
is built as part of `build_pianoid_cuda.bat`, the runtime `sys.path` shim
is deleted. The two SDL3 audio drivers (Pianoid synthesis + RR recording)
share the SAME `SDL3.dll` binary going forward (Q7 — light merge only,
~2 days). **No full C++ driver merge** — the dev-mastop pause/resume
contention dance survives.

Streaming progress is added (Q8): the backend appends a structured
`messages: [...]` list to the collection status response and the frontend
renders a rolling log via a new `<CollectionLog>` component underneath the
existing progress bar.

**Cutover policy (N8).** The legacy v1 `/modal/collect/*` endpoints are
hard-cut at Phase 2 ship — they are not kept as wrappers. After Phase 2
ships, every old path returns `410 Gone` with a body pointing at the
replacement `/modal/measurements/{id}/...` endpoint. The frontend stops
calling them at the same release. No indefinite-deprecation surface to
maintain.

**Phasing (this is XL — must be staged):**

| Phase | Scope | Effort | Risk | Gate |
|---|---|---|---|---|
| **0 — Pre-port** | Move `RoomResponseRecorder` + `DatasetCollector` + `signal_processor` + `MicTesting` + `generate_missing_averages` + `sdl_audio_core` source into PianoidCore. Delete `_room_response_bootstrap.py`. Build via `build_pianoid_cuda.bat`. Last "everything works as before" snapshot. | ~1 week | Med | Gate 1 |
| **1 — Data model + REST** | Introduce **Measurement** entity backend-side (filesystem layout, JSON schema, REST endpoints, migration script for existing projects). Existing Projects re-bind to a synthesised Measurement parent. | ~2 weeks | Med-High | Gate 2 |
| **2 — Collection UX** | Rebuild Collect subpanel: 5 sections (General / Audio Devices / Impulse / Series / Calibration Quality Criteria) + Setup Test in 3 surfaces. | ~1.5 weeks | Med | Gate 3 |
| **3 — Project subpanel slim-down + branching UI** | Project subpanel becomes ESPRIT-only. New "New project from this Measurement" button replaces Copy From. | ~3–5 days | Low | — |
| **4 — Streaming progress messages** | Backend `messages: [...]` append; frontend rolling log component. | ~1 day | Low | — |
| **5 — Light SDL3.dll share** | Both drivers link the same `SDL3.dll` binary (deployment hygiene; no API merge). | ~2 days | Low | Gate 4 |

**Total: ~5–6 weeks** for one engineer; some phases can interleave once
Phase 1 lands.

**Strong recommendations:**

- **Phase 0 is mandatory pre-work.** Promoting Measurement to a first-class
  entity while the recorder code still lives across two repos compounds
  cross-cutting risk. Land Phase 0 cleanly (everything that worked before
  Phase 0 still works) before changing data model.
- **Phase 1 needs a one-shot migration script.** Migrating Projects in-place
  (each existing project becomes Measurement + Project) is the single
  highest-risk item in this whole plan. The script must be idempotent,
  dry-runnable, and produce a roll-back tarball.
- **Phase 5 can ship anytime after Phase 0** — it is purely a build-system
  cleanup with no functional surface. Defer if calendar pressure.

---

## 2. Data Model

### 2.1 Today's Project (single entity)

```
{projects_base}/                # default D:\modal_projects
  {project_name}/
    project.json                # mixes acquisition + analysis fields
    measurements/
      scenario_3.npy            # combined (T, n_channels) array
      ...
    {computer}-Scenario{N}-{room}/   # per-scenario RR hierarchy
      raw_recordings/  *.wav
      impulse_responses/  *.wav, *.npy
      room_responses/  *.wav
      averaged_responses/  average_chN.npy
      metadata/  session_metadata.json
    modal_adapter/
      esprit/        # config + per-scenario results
      tracking/      # chains.json + edits + history
      feedin/        # feedin_data.json
      mapping/       # mapping_config.json (ALSO acquisition-side!)
      output/        # applied.json
```

`project.json` today carries:

| Field | Concern | Goes to |
|---|---|---|
| `name`, `created`, `copied_from` | identity | both (split below) |
| `sample_rate`, `num_scenarios`, `num_channels`, `scenario_indices` | acquisition | **Measurement** |
| `measurement_source` | acquisition | **Measurement** |
| `band_config` (per-band ESPRIT defaults) | analysis | **Project** |
| `ir_working_length_ms`, `ir_fade_length_ms` | analysis (averaging) | **Project** |
| `extracted_path` | acquisition (lineage) | **Measurement** |

`mapping_config.json` is fully acquisition-side and moves to **Measurement**.

### 2.2 Proposed: Measurement + Project

**On-disk layout (proposed):**

```
{measurements_base}/             # default D:\modal_measurements (override via $PIANOID_MEASUREMENTS_DIR, see N2)
  {measurement_id}/              # e.g. "Belarus piano 2026-05-06" (= globally unique display name, N1)
    measurement.json             # see schema below
    raw/
      raw_recordings/           # the actual *.wav (one per pulse cycle)
      impulse_responses/        # per-channel IR (*.wav, *.npy)
      room_responses/           # averaged room response per measurement
      metadata/
        session_metadata.json   # collector-emitted, immutable
    setup/
      mapping_config.json       # channel roles, layout, pitch_offset, bridge_boundary
      audio_config.json         # input/output device, multichannel_config (locked)
      impulse_config.json       # impulse_form, pulse params, voice_coil
      series_config.json        # num_pulses, cycle_duration, num_measurements, etc.
      calibration_criteria.json # quality thresholds (see §2.5)
    setup_test/                 # latest Setup Test result ONLY (overwritten per run, retention=1, N3)
      latest.json               # pass / warn / fail per criterion
      latest.wav                # the test impulse capture
    locks/
      acquisition.lock          # written after FIRST successful scenario (N4)

{projects_base}/                 # default D:\modal_projects (unchanged)
  {project_name}/
    project.json                 # see schema below — now thin
    modal_adapter/
      esprit/                    # config + per-scenario results
      tracking/                  # chains.json + edits + history
      feedin/                    # feedin_data.json
      averaging/                 # NEW — per-project averaged_responses (see §2.4)
        averaged_responses/
          average_chN.npy
        averaging_config.json
      output/                    # applied.json
      export_text/               # cached text export artifacts
```

**Key invariants (locked):**

- **N1 — Unique-name rule.** `measurement_id` IS the user-facing display
  name (after light slug-normalisation: trim, collapse whitespace, strip
  filesystem-illegal characters). Duplicate names are blocked at creation
  time with a `409 Conflict` response. There is no opaque suffix and no
  display-disambiguation case in the UI: a Measurement called "Belarus
  piano 2026-05-06" is the only thing it can ever be called. The user is
  free to use any unique string they like.
- **N4 — Auto-lock after first scenario.** `acquisition.lock` is written
  the moment the FIRST scenario successfully completes (not at "the last
  expected scenario", not "manual only"). From that point on, `setup/*`
  is sealed. A persistent **Unlock with warning** button in the Collection
  subpanel header is always available for advanced cases (re-takes,
  partial sweeps, calibration runs against an existing layout). Unlocking
  emits a yellow banner on every linked Project saying "Parent
  Measurement was unlocked — your snapshot is preserved, but newly-branched
  Projects will see edits made after this point."
- `setup/` is **locked alongside** `raw/`. The Setup Test artefact
  (`setup_test/latest.*`) is overwritten on every test run (N3) and is
  unaffected by acquisition lock — the test can be re-run for diagnostics
  at any time.
- **N2 — Cross-machine portability.** `project.json` carries BOTH
  `measurement_id` AND an absolute `measurement_path`. Resolution at
  Project-open time:
  1. Try `$PIANOID_MEASUREMENTS_DIR/{measurement_id}/`. Use it if present.
  2. Else fall back to the absolute `measurement_path`. Use it if present.
  3. Else surface a "Parent Measurement not found on this machine"
     dialog with a Browse button to locate it manually. Once located,
     update `measurement_path` in `project.json`.
- **N5 — Snapshot semantics.** When a Project is created (either fresh
  from a Measurement or branched from a sibling Project), the Project
  records a deep copy of the parent Measurement's `setup/*` JSON files
  into `project.json` under a `measurement_snapshot` block (see §2.3.6).
  This snapshot is FROZEN — subsequent edits to the parent Measurement
  (after unlock) do not propagate into existing Projects. Only newly-
  branched Projects see edited setup. ESPRIT results computed against the
  snapshot remain valid forever, regardless of what happens upstream.
- A Project can never be "moved" to a different Measurement — start a new
  Project instead. (Branching is cheap; mis-binding a Project to a
  different acquisition would invalidate every cached ESPRIT result.)

### 2.3 JSON Schemas

#### 2.3.1 `measurement.json`

```json
{
  "schema_version": 1,
  "measurement_id": "Belarus piano 2026-05-06",   // = globally unique display name (N1)
  "created": "2026-05-06T10:13:42Z",
  "created_by": "ModalAdapter v0.X",
  "sample_rate": 48000,
  "scenario_indices": [0, 1, 2, ..., 87],
  "num_scenarios": 88,
  "num_channels": 16,
  "acquisition_locked": true,
  "acquisition_locked_at": "2026-05-06T10:18:55Z", // auto-set after first scenario (N4)
  "setup": {
    "mapping_config_path": "setup/mapping_config.json",
    "audio_config_path": "setup/audio_config.json",
    "impulse_config_path": "setup/impulse_config.json",
    "series_config_path": "setup/series_config.json",
    "calibration_criteria_path": "setup/calibration_criteria.json"
  },
  "raw_path": "raw",
  "extras": { /* free-form */ }
}
```

> **N1 — `display_name` removed.** The earlier draft of this schema
> carried both `measurement_id` (opaque hash) and `display_name`
> (human-readable). With N1 locked in (names ARE the IDs and are
> globally unique), the redundancy is gone — `measurement_id` IS the
> display name. The frontend renders it verbatim.

#### 2.3.2 `setup/audio_config.json`

```json
{
  "schema_version": 1,
  "input_device": 3,
  "input_device_name": "MOTU UltraLite-mk5 (1)",
  "output_device": 1,
  "output_device_name": "MOTU UltraLite-mk5 (2)",
  "sdl_version": "3.2.0",
  "multichannel_config": {
    "enabled": true,
    "num_channels": 16,
    "channel_names": ["bridge-1", ..., "force"],
    "calibration_channel": 15,
    "reference_channel": 0,
    "response_channels": [0, 1, ..., 13],
    "normalize_by_calibration": true,
    "alignment_correlation_threshold": 0.7,
    "alignment_target_onset_position": 0
  }
}
```

#### 2.3.3 `setup/impulse_config.json`

```json
{
  "schema_version": 1,
  "impulse_form": "voice_coil",        // sine | square | voice_coil
  "pulse_duration_ms": 8.0,            // sine/square only
  "pulse_frequency_hz": 1000,          // sine only
  "pulse_fade_ms": 0.1,
  "pulse_smoothing_ms": 0.0,
  "invert_polarity": false,
  "voice_coil_config": {
    "init_pos_ms": 0.0,
    "init_pos_amplitude": -0.1,
    "positive_ms": 20.0,
    "gap_ms": 10.0,
    "negative_ms": 100.0,
    "pullback_amplitude": 0.5
  }
}
```

#### 2.3.4 `setup/series_config.json`

```json
{
  "schema_version": 1,
  "num_pulses": 8,                     // pulses per cycle
  "cycle_duration_ms": 100.0,
  "record_extra_time_ms": 200.0,
  "volume": 0.4,
  "num_measurements": 5,               // pulse-cycles per scenario
  "measurement_interval_s": 0.5,
  "recording_mode": "standard",        // standard | calibration — per-Measurement, applies to all scenarios (N7)
  "averaging_start_cycle": 2
}
```

> **Note on averaging.** The `averaging_start_cycle` field is acquisition-side
> only (it controls which raw cycles enter the recorder's per-cycle alignment
> step before the per-cycle data is written to disk). Project-time averaging
> (§2.4) is a separate pass that reads the per-cycle recordings.
>
> **Note on `recording_mode` (N7).** This field is set ONCE per Measurement
> at creation time and applies to every scenario in the Measurement. The
> backend rejects any per-scenario override at `start` time. To collect a
> calibration sweep against the same physical setup, create a separate
> Measurement explicitly tagged `recording_mode: "calibration"` — the two
> Measurements can share Project lineage via the branching UI (§4.2) but
> are first-class siblings on disk.

#### 2.3.5 `setup/calibration_criteria.json`

```json
{
  "schema_version": 1,
  "criteria": [
    {
      "id": "calibration_correlation_min",
      "label": "Calibration channel cycle correlation ≥",
      "value": 0.85,
      "applies_to": "calibration_channel",
      "fail_action": "fail"             // fail | warn | info
    },
    {
      "id": "input_silence_max_dbfs",
      "label": "Per-receiver baseline silence ≤ (dBFS)",
      "value": -50.0,
      "applies_to": "all_response_channels",
      "fail_action": "fail"
    },
    {
      "id": "input_clipping_count_max",
      "label": "Per-receiver clipping samples ≤",
      "value": 0,
      "applies_to": "all_response_channels",
      "fail_action": "fail"
    },
    {
      "id": "input_signal_min_dbfs",
      "label": "Per-receiver signal peak ≥ (dBFS)",
      "value": -30.0,
      "applies_to": "all_response_channels",
      "fail_action": "warn"
    },
    {
      "id": "alignment_correlation_min",
      "label": "Inter-cycle alignment correlation ≥",
      "value": 0.7,
      "applies_to": "calibration_channel",
      "fail_action": "warn"
    }
  ]
}
```

The criteria editor (Phase 2) lets the user add / remove / edit rows;
`id` strings are user-editable but must be unique within the file.

#### 2.3.6 `project.json` (NEW thin form)

```json
{
  "schema_version": 2,                     // bump from v1
  "name": "Belarus_v3_strict_bands",
  "created": "2026-05-06T11:50:00Z",
  "measurement_id": "Belarus piano 2026-05-06",
  "measurement_path": "D:\\modal_measurements\\Belarus piano 2026-05-06",
  "branched_from": null,                   // optional sibling project name (informational)
  "measurement_snapshot": {                // N5 — frozen at Project creation time
    "snapshot_taken_at": "2026-05-06T11:50:00Z",
    "audio_config": { /* deep-copy of setup/audio_config.json at branch-time */ },
    "impulse_config": { /* deep-copy of setup/impulse_config.json at branch-time */ },
    "series_config": { /* deep-copy of setup/series_config.json at branch-time */ },
    "mapping_config": { /* deep-copy of setup/mapping_config.json at branch-time */ },
    "calibration_criteria": { /* deep-copy of setup/calibration_criteria.json at branch-time */ }
  },
  "averaging": {
    "ir_working_length_ms": 1000,
    "ir_fade_length_ms": 5,
    "force_reaverage": false,
    "qc_threshold": 0.1
  },
  "esprit": { /* band_config + advanced; same shape as today */ },
  "tracking": { /* method, freq tolerance %, max gap, ... */ },
  "applied": false,
  "applied_preset": null
}
```

The `branched_from` field replaces `copied_from`; it is informational only
(provenance of the analysis config, not data).

The `measurement_snapshot` block (N5) is a deep-copy of the parent
Measurement's `setup/*` JSON files, taken at Project creation time and
NEVER modified thereafter. ESPRIT and downstream analysis read from this
snapshot — not from the live parent — so unlock + edit on the parent is
safe with respect to existing Projects. New Projects branched after the
edit see the new setup; existing Projects keep their snapshot.

**Project name uniqueness.** Project names are unique only within
`{projects_base}/`; there is no global registry. (Measurement names are
globally unique under `{measurements_base}/` per N1.)

### 2.4 Project-Time Averaging (Q3)

**Decision:** Measurement stores raw per-cycle recordings only; each Project
runs its own averaging pass.

Concretely:

- The Measurement's `raw/` tree contains everything emitted by
  `RoomResponseRecorder` + `SingleScenarioCollector`: per-pulse `.wav`
  files in `raw_recordings/`, per-channel impulse responses in
  `impulse_responses/`, and the per-measurement averaged room responses in
  `room_responses/`. **Crucially, there is no `averaged_responses/` at the
  Measurement level** — that artefact moves under each Project.
- Each Project owns `modal_adapter/averaging/averaged_responses/average_chN.npy`,
  generated by a Project-scoped `generate_averaged_responses_for_scenario`
  pass that reads the parent Measurement's `room_responses/` (or, if a
  more aggressive averaging mode is desired in the future, the raw
  per-cycle recordings).
- The Project's `averaging_config.json` carries `ir_working_length_ms`,
  `ir_fade_length_ms`, `force_reaverage`, `qc_threshold`. This config is
  the per-Project knob the user already understands today (the existing
  Effective Signal Length QC + re-average flow continues to apply).

**Implication.** Today's `measurements/scenario_N.npy` mirror (the flat
shape that `_discover_npy_scenarios` consumes — `modal_adapter.py:1348+`)
also moves to the Project (alongside `averaged_responses/`). This keeps
the existing ESPRIT input contract identical: ESPRIT reads
`{project}/measurements/scenario_N.npy` exactly as it does today; only
the directory walks deeper into the Project and not into a sibling of
ESPRIT data.

### 2.5 Setup Test (Q4 + Q5 merged, N3 retention)

**ONE** standardised test, implemented as ONE shared `<SetupTest>`
component (Q4 + Q5), exposed in three surfaces (Audio Devices section,
Impulse properties section, Collection pre-flight check). Mechanically
identical in every surface — the only difference between surfaces is the
wrapping CTA copy and the position in the layout. The component validates
calibration impulse quality AND input on every receiver in a single pass.

Procedure (identical in every surface):

1. Validate the saved `setup/audio_config.json` opens without SDL error.
2. Generate one calibration impulse using the saved
   `setup/impulse_config.json`.
3. Play out + record one cycle (no scenario folder created — this is a
   transient one-shot).
4. Run the recording through the same alignment + per-cycle validation
   pass that `signal_processor` runs during real collection.
5. Compare every recorded channel against `setup/calibration_criteria.json`.
6. Emit a unified report:

   ```json
   {
     "schema_version": 1,
     "tested_at": "2026-05-06T11:14:08Z",
     "overall": "pass",                       // pass | warn | fail
     "results": [
       {
         "criterion_id": "calibration_correlation_min",
         "channel": "calibration",
         "measured": 0.92,
         "threshold": 0.85,
         "verdict": "pass"
       },
       {
         "criterion_id": "input_signal_min_dbfs",
         "channel": "bridge-7",
         "measured": -34.0,
         "threshold": -30.0,
         "verdict": "warn"
       }
     ],
     "recording_path": "setup_test/latest.wav"
   }
   ```

7. **Overwrite** `setup_test/latest.json` and `setup_test/latest.wav`
   under the parent Measurement (N3 — retention = 1, latest only). There
   is no Setup Test history; the previous result is discarded on every
   new run. Rationale: Setup Tests are diagnostic checkpoints, not
   archival data — keeping a history would accumulate hundreds of WAVs
   per Measurement with no analysis value.

`overall` is `fail` if any `fail_action: "fail"` criterion failed; else
`warn` if any `fail_action: "warn"` criterion failed; else `pass`.

**Pre-flight surface (Collection start).** Before the user can press Start
Collection on a not-yet-locked Measurement, the latest Setup Test must
report `overall ∈ {pass, warn}`. A `fail` surfaces a blocking dialog
("Last Setup Test failed: <criterion>. Re-run the test or edit
criteria."). A `warn` surfaces a non-blocking yellow chip the user must
acknowledge ("Proceed anyway"). After the Measurement is locked
(`acquisition.lock` exists per N4), the Setup Test is read-only — it can
be re-run for diagnostics but does not gate anything (because no further
acquisition will happen against this lock state without an explicit
unlock).

---

## 3. REST API Surface

### 3.1 New Measurement Endpoints

All under `/modal/measurements/...` on the modal-adapter server (port 5001).

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/modal/measurements`                                | List all measurements (id, num_scenarios, num_channels, locked, created) |
| `POST`   | `/modal/measurements`                                | Create a new (empty) Measurement. Body: `{measurement_id, sample_rate, mapping_config?, layout_type?, recording_mode, ...}`. Returns `{measurement_id, path}`. **Returns `409 Conflict` if `measurement_id` is already taken (N1 — names are globally unique IDs).** |
| `GET`    | `/modal/measurements/{id}`                           | Full measurement.json + setup/* contents inline |
| `POST`   | `/modal/measurements/{id}/setup/audio_config`        | Update `setup/audio_config.json` (rejected `423 Locked` if `acquisition.lock` exists; user must POST `/unlock` first) |
| `POST`   | `/modal/measurements/{id}/setup/impulse_config`      | Update `setup/impulse_config.json` (rejected `423 Locked` if locked) |
| `POST`   | `/modal/measurements/{id}/setup/series_config`       | Update `setup/series_config.json` (rejected `423 Locked` if locked). `recording_mode` is per-Measurement (N7) and cannot be overridden per-scenario at `start` time. |
| `POST`   | `/modal/measurements/{id}/setup/mapping_config`      | Update `setup/mapping_config.json` (rejected `423 Locked` if locked) |
| `POST`   | `/modal/measurements/{id}/calibration_criteria`      | Edit `setup/calibration_criteria.json` (allowed even after lock — criteria are an analysis-time gate, not an acquisition input). |
| `POST`   | `/modal/measurements/{id}/setup_test`                | Run one Setup Test cycle. **Overwrites** `setup_test/latest.json` + `setup_test/latest.wav` (N3 — retention=1). Returns `{overall, results[], recording_path}`. |
| `GET`    | `/modal/measurements/{id}/setup_test`                | Fetch the latest Setup Test report (or `404` if none has been run). No history endpoint exists — only the latest is retained. |
| `POST`   | `/modal/measurements/{id}/collect/start`             | Start a real collect-scenario session. Same payload shape as today's `/modal/collect/start` minus the recorder_config bag (which now lives in setup/). On the FIRST successful scenario completion, `acquisition.lock` is auto-written (N4). |
| `GET`    | `/modal/measurements/{id}/collect/status`            | Per-Measurement session snapshot (now includes `messages: [...]`) |
| `POST`   | `/modal/measurements/{id}/collect/cancel`            | Cancel active collection |
| `GET`    | `/modal/measurements/{id}/collect/results/{sid}`     | Fetch completed scenario result |
| `POST`   | `/modal/measurements/{id}/unlock`                    | Manual unlock with warning (N4 — "Unlock with warning" button). Requires `confirm: true`. Emits a stale-snapshot warning to every linked Project's status. The lock state can be re-acquired by collecting another scenario (auto-lock fires again on the next successful scenario). |
| `GET`    | `/modal/measurements/{id}/devices`                   | Enumerate SDL3 devices (replaces today's `/modal/collect/devices`) |
| `DELETE` | `/modal/measurements/{id}`                           | Delete Measurement. **Returns `409 Conflict` with `{linked_projects: [...]}` if any Project references this Measurement** (N6 — Measurements are NEVER auto-deleted; the user must first delete or re-bind the linked Projects, then explicitly delete the Measurement from the Measurement-list view). There is no `force: true` flag. |

### 3.2 Updated Project Endpoints

Existing `/modal/projects/...` endpoints remain — Project lifecycle is
unchanged from the user's perspective except that creation now requires a
`measurement_id`:

| Method | Path | Change |
|--------|------|---------|
| `POST` | `/modal/projects`                                  | NEW — body `{name, measurement_id, averaging?, esprit?}`. Server snapshots the parent Measurement's `setup/*` into `project.json.measurement_snapshot` at create time (N5). Replaces `create_from_zip` + `create_from_folder`. |
| `POST` | `/modal/projects?measurement={id}`                 | URL-param convenience form (alternative to body field) |
| `POST` | `/modal/projects/<old>/branch`                     | NEW — body `{new_name}`. Creates a sibling Project pointing at the SAME measurement_id. **Snapshots the parent Measurement's CURRENT setup at branch time (N5)** — this can differ from the source Project's snapshot if the parent Measurement was unlocked + edited in between. Fresh ESPRIT config (defaults inherited from `branched_from` if requested). Replaces today's Copy From flow. |
| `POST` | `/modal/projects/create_from_zip`                  | RETIRED at Phase 2 (N8 — hard cutover). Returns `410 Gone` with body pointing at `POST /modal/projects` + Measurement creation flow. |
| `POST` | `/modal/projects/<n>/reaverage`                    | UNCHANGED behaviour (re-runs the Project-scoped averaging pass), but now reads from `{measurement_path}/raw/room_responses/` instead of the project's own folder. |
| `POST` | `/modal/projects/<n>/rename`                       | UNCHANGED |
| `POST` | `/modal/projects/copy`                             | RETIRED at Phase 2 (N8 — hard cutover). Returns `410 Gone` with body pointing at `POST /modal/projects/<old>/branch`. |
| `POST` | `/modal/projects/delete`                           | UNCHANGED behaviour, **but the "also delete extracted measurements" checkbox is REMOVED** (N6 — Measurements are never auto-deleted on Project delete, even if this is the last referencing Project). The dialog now displays a small read-only line "Parent Measurement: {id} — will not be deleted. To delete the Measurement, use the Measurement-list view." |

### 3.3 Streaming Progress Messages (Q8)

Today `GET /modal/collect/status` returns:

```json
{
  "session_id": "abc",
  "phase": "recording",
  "progress_pct": 42,
  "scenario_number": 0
}
```

Phase 4 adds `messages` — an append-only ring buffer of structured
progress events emitted by the worker thread. The new shape:

```json
{
  "session_id": "abc",
  "phase": "recording",
  "progress_pct": 42,
  "scenario_number": 0,
  "messages": [
    {"ts": "2026-05-06T11:14:08.123Z", "level": "info",  "src": "session", "msg": "Pause synthesis OK"},
    {"ts": "2026-05-06T11:14:08.421Z", "level": "info",  "src": "recorder", "msg": "Open input device 'MOTU UltraLite-mk5 (1)' [16ch]"},
    {"ts": "2026-05-06T11:14:08.422Z", "level": "info",  "src": "recorder", "msg": "Open output device 'MOTU UltraLite-mk5 (2)'"},
    {"ts": "2026-05-06T11:14:09.013Z", "level": "info",  "src": "collector", "msg": "Measurement 1/8 starting"},
    {"ts": "2026-05-06T11:14:09.514Z", "level": "warn",  "src": "signal", "msg": "Cycle 3 alignment correlation 0.68 < 0.7 — proceeding"},
    {"ts": "2026-05-06T11:14:10.001Z", "level": "info",  "src": "collector", "msg": "Measurement 1/8 done (cycles 8/8 aligned)"},
    {"ts": "2026-05-06T11:14:18.221Z", "level": "info",  "src": "session", "msg": "Saving averaged_responses..."},
    {"ts": "2026-05-06T11:14:19.802Z", "level": "info",  "src": "session", "msg": "Resume synthesis OK"}
  ]
}
```

The buffer is capped (recommend 256 entries; older entries drop). Levels:
`info | warn | error | debug`. `src` is one of the known emitters
(`session`, `recorder`, `collector`, `signal`, `setup_test`).

The frontend displays a small rolling log under the existing progress
bar — same height contract as today's status line. Auto-scroll
to-bottom; click-to-pause; level chips (warn = amber, error = red).

### 3.4 Endpoints Removed — Hard Cutover at Phase 2 (N8)

**Policy.** All v1 `/modal/collect/*` endpoints are **retired at the Phase 2
ship**, not maintained as compatibility wrappers. After Phase 2 ships, every
old path returns `410 Gone` with a JSON body pointing at the v2 replacement:

```json
{
  "error": "endpoint_retired",
  "retired_at": "v2",
  "phase": "Phase 2",
  "replacement": "/modal/measurements/{id}/collect/start",
  "doc": "docs/proposals/modal-adapter-measurement-entity-2026-05-10.md#34-endpoints-removed--hard-cutover-at-phase-2-n8"
}
```

The frontend stops calling these endpoints in the same release. There is
no indefinite-deprecation surface to maintain.

| Old endpoint | Replacement |
|---|---|
| `GET /modal/collect/health`     | `GET /modal/measurements/health` — trivial `{available: true, sdl_version}` (no RoomResponse import probe — there's no longer an external dep). |
| `GET /modal/collect/devices`    | `GET /modal/measurements/{id}/devices` (per-Measurement, primary surface). An unscoped `GET /modal/measurements/devices` alias is kept for the "Audio Devices" section in the Create-Measurement flow (no measurement_id yet at that point). |
| `POST /modal/collect/start`     | `POST /modal/measurements/{id}/collect/start`. |
| `GET /modal/collect/status`     | `GET /modal/measurements/{id}/collect/status`. The global "any session in flight?" probe survives as `GET /modal/measurements/active_session` returning `{measurement_id, session_id, phase} | null`. |
| `POST /modal/collect/cancel`    | `POST /modal/measurements/{id}/collect/cancel`. |

**Phase 1 transition window (one release).** During Phase 1 (between
shipping the new endpoints and shipping Phase 2's frontend cut-over), the
v1 endpoints DO continue to work as legacy wrappers — they internally
allocate a synthetic Measurement-id-of-the-day and forward to the v2
handler. This is the only time the legacy surface is alive in v2. As soon
as Phase 2 ships, the wrappers are deleted in the same commit that ships
the new frontend.

---

## 4. Frontend

### 4.1 Collection Subpanel — Five Sections

The Collection subpanel is the entry point for **Measurement** acquisition.
It replaces today's `CollectPanel.jsx` (`PianoidTunner/src/components/CollectPanel.jsx`).
Mounted from the Modal Adapter top-level when `activeSection === "collect"`,
**scoped to a selected Measurement** (top-row selector "Measurement: [Belarus-2026-05-06] [+ New Measurement]").

Each section is a collapsible MUI Accordion following the canonical
"Settings section" pattern (per-section dirty flag + per-section "Save
Settings" button + lock chip when `acquisition_locked === true`).

**Section A — General**

| Field | Type | Source | Notes |
|---|---|---|---|
| Measurement ID (= name) | TextField | `measurement.measurement_id` | Set at creation time; **never editable after creation** (N1 — names are unique IDs and renaming would break every linked Project's `measurement_id` reference). To "rename", create a new Measurement and re-collect (or use the planned "duplicate Measurement" tool, future scope). |
| Layout | Radio (line / grid) | `setup/mapping_config.layout_type` | Drives the channel-mapping editor below |
| Channel mapping | inline `MappingEditor` (full editor — NOT a read-only summary) | `setup/mapping_config.json` | Locked once acquisition starts (N4); the same editor used today in the Setup subpanel — moved here, not duplicated |
| Layout-specific editor (grid only) | `GridLayoutEditor` (rows/cols/spacing/cell mask) | `setup/mapping_config.json` | Only rendered when layout=grid; locked alongside channel mapping |
| `description` / `computer` / `room` | TextField ×3 | scenario folder naming | Per-scenario; not locked at Measurement level — they are passed at start-collect time |

**Subpanel header — Unlock with warning button (N4).** When the
Measurement is locked (`acquisition.lock` exists), a persistent
**Unlock with warning** button appears in the Collection subpanel header
next to the lock chip. Clicking it surfaces a confirm dialog:

> Unlocking this Measurement allows you to edit the audio device, impulse,
> series, or mapping setup, OR to record additional scenarios. **Existing
> Projects branched from this Measurement keep their snapshot and are
> unaffected.** Newly-branched Projects will see the edits made after
> unlock. Continue?

Confirm → `POST /modal/measurements/{id}/unlock {confirm: true}` →
`acquisition.lock` deleted, all `setup/*` editors become live again.
The lock will auto-fire again on the next successful scenario.

> **Channel-mapping ownership change.** Today the `MappingEditor` lives
> inside the Modal Adapter Setup subpanel (`ModalAdapter.jsx:891-1003`).
> In the new model the editor moves to the Collection > General section
> because layout + channel roles are acquisition-time facts. The Setup
> subpanel's mapping editor either (a) becomes a read-only summary that
> links to Collection > General for the parent Measurement, or (b) is
> removed entirely — recommendation is (a) so the user can always inspect
> the mapping while configuring ESPRIT.

**Section B — Audio Devices**

| Field | Type | Source | Notes |
|---|---|---|---|
| Input device | Select | `setup/audio_config.input_device` | Populated by `GET /modal/measurements/devices` |
| Output device | Select | `setup/audio_config.output_device` | Same |
| Refresh devices | button | re-calls devices endpoint | |
| SDL version display | read-only text | from devices endpoint | |
| `multichannel_config.enabled` | Switch | `setup/audio_config.multichannel_config.enabled` | |
| `multichannel_config.num_channels` | NumInput | same | |
| `multichannel_config.channel_names` | editable list | same | |
| `multichannel_config.calibration_channel` | Select int / None | same | |
| `multichannel_config.reference_channel` | Select int | same | |
| `multichannel_config.response_channels` | multi-select chips | same | |
| `multichannel_config.normalize_by_calibration` | Switch | same | |
| `multichannel_config.alignment_correlation_threshold` | NumInput | same | |
| `multichannel_config.alignment_target_onset_position` | NumInput | same | |
| **Setup Test** button | action | `POST /modal/measurements/{id}/setup_test` | Renders pass/warn/fail report inline. Overwrites the previous Setup Test result (N3 — retention=1, no history). The result is also visible in the pre-flight banner above Section A. |

**Section C — Impulse**

| Field | Type | Source |
|---|---|---|
| `impulse_form` | Select (sine / square / voice_coil) | `setup/impulse_config.impulse_form` |
| `pulse_duration_ms` | NumInput | (sine/square only) |
| `pulse_frequency_hz` | NumInput | (sine only) |
| `pulse_fade_ms` | NumInput | |
| `invert_polarity` | Switch | |
| `pulse_smoothing_ms` | NumInput | |
| **Voice-coil sub-block** (when `impulse_form === 'voice_coil'`) | nested 6 fields | `setup/impulse_config.voice_coil_config` |
| **Setup Test** button | action | same endpoint as Section B |
| Calculated waveform preview | small ECharts plot | client-derived from current values | Optional Phase 2.5 (no backend dep) |

**Section D — Series**

| Field | Type | Source |
|---|---|---|
| `num_pulses` | NumInput | `setup/series_config.num_pulses` |
| `cycle_duration_ms` | NumInput | |
| `record_extra_time_ms` | NumInput | |
| `volume` | NumInput | |
| `num_measurements` | NumInput | |
| `measurement_interval_s` | NumInput | |
| `recording_mode` | Radio (Standard / Calibration) | Per-Measurement only (N7); applies to every scenario in this Measurement. Not overridable per-scenario. |
| `averaging_start_cycle` | NumInput | |
| Calculated: gap duration / series duration / duty cycle / pulse rate | read-only derived | client-side |

**Section E — Calibration Quality Criteria** (NEW)

A small editable table (one row per criterion) with `add row` /
`remove row` controls. Columns:

| Column | Type |
|---|---|
| Criterion ID | text |
| Label | text |
| Threshold | numeric |
| Applies to | Select (`calibration_channel` / `reference_channel` / `all_response_channels` / `all_input_channels`) |
| Fail action | Select (`fail` / `warn` / `info`) |

A small "Reset to defaults" button restores the proposed default rule set
from §2.3.5. **This section is editable even after acquisition lock** (the
criteria are an analysis-time gate, not an acquisition input).

**Pre-flight check (above Section A).**
A persistent banner at the top of the Collection subpanel renders the
result of the most recent Setup Test. Three states:

- Green: `Last Setup Test passed (12 min ago) [Re-run]`
- Yellow: `Last Setup Test passed with warnings — 2 channels low signal [Show report] [Re-run] [Proceed anyway]`
- Red: `Last Setup Test FAILED — calibration correlation 0.42 < 0.85 [Show report] [Re-run]` (Start Collection button disabled)

Below the banner: a single primary action **Start Collection** that
begins a scenario via `POST /modal/measurements/{id}/collect/start`.

### 4.2 Project Subpanel — Slim Down + Branching

The Project subpanel becomes ESPRIT-focused:

- Top of subpanel: **Parent Measurement card** (display name, scenario
  count, channel count, layout, lock status, link "Inspect setup →" that
  navigates to Collection > General with the parent Measurement selected).
- **Settings panel (gear icon)** — only the three analysis-side configs:
  EspritConfig (already exists), Tracking config (already exists), Apply
  config (already exists). Mapping editor is REMOVED from here (moved to
  Collection per §4.1).
- **Toolbar** — unchanged: server status, Project button, ESPRIT/Tracking/Apply
  buttons, settings gear, Play/SkipNext.

**Branching UI.** From any open Project (or from the ProjectBrowserDialog
row), a new **Branch from this Project** action creates a sibling Project
that points at the same parent Measurement. Behaviour mirrors today's
Copy From except: (a) no data is copied (the new Project just stores
`measurement_id` + `branched_from`); (b) **the new Project takes a fresh
`measurement_snapshot` of the parent Measurement's CURRENT setup at branch
time (N5)** — this can differ from the source Project's snapshot if the
parent Measurement was unlocked + edited in between; (c) ESPRIT/tracking/
feedin caches start empty as today; (d) `band_config` defaults are
inherited from the source Project unless `--reset` is checked.

**From the Measurement view.** The Collection subpanel's Measurement
selector also exposes "Projects using this Measurement" (a dropdown of
linked Project names, each clickable to jump to the Project subpanel).
A primary "+ New Project from this Measurement" button creates a fresh
ESPRIT-config child Project.

### 4.3 Streaming Log (Q8)

A new `<CollectionLog>` component renders below the existing collection
progress bar in the Collection subpanel:

- Fixed-height (recommend 200 px) scroll region with monospace font.
- Each line: `[HH:MM:SS] [src] msg` with level chip (warn = amber, error = red).
- Auto-scroll to bottom unless the user has scrolled up; "▼ Jump to latest"
  button reappears in that case.
- Persists across Start → Done so the user can review what happened.

Polling: include `messages` in the existing `/modal/measurements/{id}/collect/status`
poll; the frontend dedupes on the `ts` field.

---

## 5. Migration

This is the highest-risk single item in the proposal.

### 5.1 Existing Project → (Measurement + Project) Pair

**Trigger:** the modal-adapter server starts and detects any project under
`{projects_base}/` whose `project.json` carries `schema_version: 1`
(or has no `schema_version` field, which is also v1).

**Migration script (`migrate_v1_to_v2.py` under `pianoid_middleware/modal_adapter/migration/`):**

1. **Discover.** Walk `{projects_base}/`; collect every v1 project.
2. **Dry-run (default).** Report the planned migration without touching
   disk:
   ```
   Project 'Belarus_v3'  →  Measurement 'Belarus_v3_imported' + Project 'Belarus_v3'
       sample_rate     48000
       num_scenarios   88
       num_channels    16
       layout          line
       raw data found at: D:\modal_projects\Belarus_v3\Belarus-Scenario*-Run\
       averaged_responses found: 88 / 88
       mapping_config.json: present
       ESPRIT cache: 88 scenarios processed
   ```
3. **Per-project migration (with `--apply`):**
   - Allocate new `measurement_id`. Default is the v1 project name (e.g.
     `Belarus_v3` → `Belarus_v3_imported`). If that name already exists
     under `{measurements_base}/`, the migrator appends a numeric suffix
     (`Belarus_v3_imported_2`, `_3`, …) until unique (N1 — names are
     globally unique IDs and the migrator MUST not collide). The chosen
     name is logged in the dry-run report so the user can intervene
     before `--apply`.
   - Create `{measurements_base}/{measurement_id}/` skeleton.
   - **Move** `Belarus-Scenario*-Run/` folders into
     `{measurement_id}/raw/{ScenarioN}/`. Use rename (move) within a
     filesystem; cross-filesystem migrations fall back to copy + delete
     with verification.
   - Build `setup/audio_config.json` from whatever the project carries
     today — the legacy `recorderConfig.json` defaults if no project
     override exists. Mark `migrated: true` so the user knows the audio
     device record is best-effort.
   - Build `setup/impulse_config.json` + `setup/series_config.json`
     similarly from `recorderConfig.json` defaults.
   - **Move** `mapping_config.json` to `setup/mapping_config.json`.
   - Synthesise a `setup/calibration_criteria.json` from the proposed
     defaults (§2.3.5).
   - Write `acquisition.lock` (the Measurement is sealed — these are
     existing recordings, not in-flight acquisitions).
   - **Move** `modal_adapter/averaging/averaged_responses/` into the new
     home if it doesn't exist there yet. Keep the legacy
     `measurements/scenario_N.npy` mirror under the Project (ESPRIT input
     contract is unchanged).
   - Update `project.json` to v2 schema: keep `name` and `created`; add
     `measurement_id` + `measurement_path`; relocate `band_config` →
     `esprit`; relocate `ir_working_length_ms` + `ir_fade_length_ms` →
     `averaging`; **deep-copy the freshly-synthesised `setup/*` JSON files
     into `measurement_snapshot` (N5)**; drop now-dead acquisition fields.
4. **Roll-back tarball.** Before any move, the script writes
   `{projects_base}/{project_name}/_pre_v2_migration.tar.gz` containing
   the full v1 layout. If migration fails halfway, the tarball is the
   ground truth for recovery.
5. **Verify.** After migration, re-open each migrated Project via
   `ModalAdapter.open_project()` and confirm:
   - All scenarios discovered (count matches v1).
   - Sample rate matches.
   - mapping_config loads cleanly.
   - At least one ESPRIT result loads (if v1 had cached results).
6. **Manual escape hatch.** Migration failures DO NOT crash the
   modal-adapter server — they emit a warning, leave the project on disk
   unchanged, and the project simply doesn't appear in the v2
   ProjectBrowserDialog until the user runs the migration script
   manually.

### 5.2 Lock Semantics During Migration (N4)

A migrated Measurement always lands in **locked** state — this is the
same auto-lock semantics that applies to fresh Measurements after their
first scenario completes (N4). The migrator always writes
`acquisition.lock` regardless of whether v1's `Belarus-Scenario*-Run/`
folders contained one scenario or eighty-eight; the assumption is that
any v1 project on disk represents a completed (or at least paused)
acquisition, not an in-flight one.

To re-record into a migrated Measurement, the user opens the Collection
subpanel and clicks **Unlock with warning** (the same N4 button available
to fresh Measurements). The existing raw scenarios remain in place;
unlocking allows additional scenarios to be appended. `scenario_index`
collisions raise an error rather than overwriting.

### 5.2.1 Snapshot Backfill for Migrated Projects (N5)

For each v1 Project being migrated, the migrator writes the
`measurement_snapshot` block (N5) into the new v2 `project.json` using
the SAME setup that the migration just synthesised for the parent
Measurement. This means: every migrated Project's snapshot exactly
matches its parent Measurement's setup at migration time, and any
subsequent unlock + edit on the parent Measurement leaves migrated
Projects unaffected (same guarantee as for newly-branched Projects).

### 5.3 Frontend Cut-Over

The frontend ships with both v1 and v2 code paths in Phase 1:

- v1: existing CollectPanel + Project subpanel rendering pre-migrated projects.
- v2: new Collection + Project subpanels rendering migrated projects.

A user-facing **"Migrate to v2 schema"** button in the Project subpanel
triggers per-project migration via a new `POST /modal/projects/{name}/migrate_to_v2`
endpoint. After Phase 2 ships, the v1 path is removed and any remaining
v1 projects auto-migrate at server start (with the rollback tarball).

---

## 6. Phasing — Detailed

### Phase 0 — Pre-Port (~1 week, Gate 1)

> **Phase 0 IMPLEMENTED at dev-rrport (2026-05-10).** Branch
> `feature/dev-rrport-phase0-rrport` on PianoidCore + matching docs PR
> on PianoidInstall. See session log
> [`docs/development/logs/active/dev-rrport-2026-05-10-232416.md`](../development/logs/active/dev-rrport-2026-05-10-232416.md)
> for the per-issue decisions (notably: ported a 7th file
> `calibration_validator_v2.py` not in the original scope; vendored
> `recorderConfig.json` as `default_recorderConfig.json`; reused
> pianoid_cuda's `build_config.json` for sdl_audio_core).
> **Gate 1 sign-off (Belarus byte-equal end-to-end) is deferred** —
> the unit/integration test layer passes; the live measurement
> comparison against a reference run requires hardware and is out of
> scope for the dev-rrport agent's deliverable.

**Scope.**
- Move `RoomResponseRecorder.py` (1457 LOC), `DatasetCollector.py` (995 LOC),
  `signal_processor.py` (594 LOC), `MicTesting.py` (177 LOC),
  `generate_missing_averages.py` (217 LOC), `multichannel_filename_utils.py`
  (264 LOC subset) into
  `PianoidCore/pianoid_middleware/modal_adapter/measurement/`.
- **Implementation note (dev-rrport):** also ported
  `calibration_validator_v2.py` (749 LOC) as the 7th file →
  `measurement/calibration_validator.py`. Required because
  `scenario_averager.py` and three test files lazy-imported this module
  from RR's `sys.path`.
- Move `RoomResponse/sdl_audio_core/` (the C++ pybind11 module source —
  ~3200 LOC C++ + ~510 LOC bindings) into `PianoidCore/sdl_audio_core/`.
- Wire `sdl_audio_core` into `build_pianoid_cuda.bat` so it builds and
  installs alongside `pianoidCuda` into `PianoidCore/.venv/Lib/site-packages/`.
  Implemented as a `:build_sdl_audio_core` subroutine that copies
  `pianoid_cuda/build_config.json` → `sdl_audio_core/build_config.json`
  before pip install, so sdl_audio_core's `setup.py` stays byte-identical
  to its RR upstream copy.
- Update `collection_engine._default_*_factory` imports to point at
  `.measurement.recorder` / `.collector` / `.averager`.
  **Implementation note:** also rewired
  `collection_engine._load_default_recorder_config` to read the vendored
  `measurement/default_recorderConfig.json` (was previously
  `D:/repos/RoomResponse/recorderConfig.json`); rewired three lazy
  imports in `scenario_averager.py`; rewired the in-process bootstrap
  probe in `modal_adapter_server.py`; dropped the bootstrap call from
  `tools/grid_search/belarus_reextract.py`.
- Delete `_room_response_bootstrap.py` shim, the
  `bootstrap_roomresponse()` call, and the `PIANOID_ROOMRESPONSE_PATH`
  env var.
- Update `MODAL_COLLECTION.md` and `OVERVIEW.md` to remove the "Wave B-0
  RoomResponse Bootstrap" section.

**Gate 1 — sign-off.** End-to-end test against the Belarus dataset:
collect one scenario via the in-tree recorder; compare the resulting
`averaged_responses/average_chN.npy` against a reference run from the
pre-port cross-repo recorder. Byte-equal (or numpy-close within float
tolerance). Three runs, no regressions in synthesis perf benchmarks.

**Gate 1 status (dev-rrport, 2026-05-10):**
Build / unit / integration test layer passes — see the dev-rrport
session log for build SHAs and test counts. The live byte-equal Belarus
comparison is deferred (requires hardware) and is the gating step for
declaring Phase 0 fully signed off.

### Phase 1 — Data Model + REST (~2 weeks, Gate 2)

> **Phase 1 IMPLEMENTED at dev-msmt (2026-05-11).** Branch
> `feature/dev-msmt-phase1-measurement-entity` on PianoidCore.
> See session log
> [`docs/development/logs/dev-msmt-2026-05-11-141141.md`](../development/logs/dev-msmt-2026-05-11-141141.md)
> for implementation decisions. Notable scope deltas vs the original
> Phase 1 plan:
>
> - **Belarus migration deferred / out of scope.** Belarus raw data
>   lives under `D:/repos/RoomResponse/piano/` (outside
>   `measurements_base`), and the migrator deliberately refuses to
>   touch paths outside its base directory. Per user direction
>   2026-05-11 the 3 Belarus-prefixed projects on this machine were
>   instead **safety-tarballed and deleted** (tarballs in
>   `D:/tmp/Belarus8D*_pre_dev-msmt_deletion.tar.gz`); the user opted
>   to reprocess Belarus from scratch in Phase 2+ rather than carry
>   v1 state forward.
> - **N8 transition window — Q4-B interpretation.** Legacy
>   `/modal/collect/*` endpoints remain literally unchanged
>   (no synthetic Measurement creation). Phase 2 deletes them with
>   410 Gone wrappers per N8.
> - **Setup Test backend wiring is a Phase 1 stub** (per spec §6 — full
>   `signal_processor.validate_calibration_quality` integration lands
>   in Phase 2). The endpoint surface + N3 single-latest retention +
>   report schema are complete.
> - **Migration verified on real data:** 3 PlyWood projects (PlyWoodTake1_7,
>   PlyWoodTake1_7_copy, PlyWoodTake1_long) migrated successfully;
>   ESPRIT chains survive (295 chains loaded post-migration on
>   PlyWoodTake1_7). Belarus byte-equal verification deferred to
>   Phase 2 once user re-acquires Belarus data through the new flow.
> - Tests: 132 new tests across 5 files (55 unit + 22 unit + 25
>   integration + 13 integration + 17 integration), 0 failures.
>   188/189 total modal-adapter tests pass (1 POSIX-only test skipped
>   on Windows host).
>
> **Gate 2 (Belarus) is deferred** — superseded by the user's
> "reprocess from scratch" decision. Gate 2 (PlyWood) signed off via
> the verification block in the dev-msmt session log.

**Scope.**
- Implement `MeasurementSession` rework: split into `Measurement` (entity
  manager) + `CollectionSession` (in-flight acquisition).
- Implement the `Measurement` filesystem layout, JSON schemas (§2.3),
  setup endpoints (§3.1). Enforce N1 unique-name constraint at create
  time. Enforce N4 auto-lock after first successful scenario. Implement
  N3 single-latest Setup Test artefact.
- Implement the migration script (§5.1) with dry-run + apply + rollback
  tarball + verification. Backfill `measurement_snapshot` (N5) for every
  migrated Project.
- Implement the v2 `project.json` shape (with `measurement_snapshot` per
  N5, with `measurement_id` + `measurement_path` per N2) and the
  `POST /modal/projects?measurement={id}` + `branch` endpoints.
- Implement N6 — `DELETE /modal/measurements/{id}` returns `409` if any
  Project references the Measurement; Project Delete dialog drops the
  "also delete extracted measurements" checkbox.
- **N8 transition window.** Keep the v1 `/modal/collect/*` endpoints
  alive as legacy wrappers ONLY during Phase 1 (between v2 endpoints
  shipping and Phase 2's frontend cut-over). They forward to the v2
  handlers via a synthetic Measurement-id-of-the-day.
- Unit tests + integration tests on the migration script using a curated
  v1-state corpus (Belarus + 2 synthetic projects).

**Gate 2 — sign-off.** Migration verified on:
- Belarus dataset (real, complex).
- A second real project.
- One synthetic project that exercises grid layout.
- One project with no mapping_config.json (legacy pre-mapping).

In each case: dry-run report matches expectation, apply produces a
loadable v2 Measurement + Project pair, ESPRIT re-runs cleanly against
the migrated data with byte-equal results to pre-migration.

### Phase 2 — Collection UX (~1.5 weeks, Gate 3)

> **Phase 2 split into 2a/2b/2c during execution (dev-msmtui sub-phase
> decomposition, 2026-05-11).** The original scope was too large for a
> single /dev session that cannot run `/test-ui`. Path B
> (sub-decomposition) was adopted:
>
> - **Phase 2a — Backend cutover (IMPLEMENTED at dev-msmtui, 2026-05-11).**
>   Setup Test backend wiring + v1 `/modal/collect/*` hard cutover to
>   410 Gone + streaming `messages` ring buffer + active-session probe
>   endpoint + tests + docs. See branch
>   `feature/dev-msmtui-phase2a-backend-cutover` on PianoidCore.
> - **Phase 2b — Frontend Collection UX (IMPLEMENTED at dev-msmtui-fe,
>   2026-05-11).** Branch
>   `feature/dev-msmtui-fe-phase2b-frontend-collection` on PianoidTunner.
>   Replaced legacy `<CollectPanel>` with `<CollectionSubpanel>` (5
>   collapsible Accordion sections + per-section Save + lock UI),
>   `<MeasurementSelector>` top-row picker (GET/POST /modal/measurements
>   with N1 409 surfacing), shared `<SetupTestPanel>` used in 3 surfaces
>   (Audio Devices, Impulse, pre-flight `<SetupTestBanner>`),
>   `<UnlockMeasurementDialog>` with verbatim N4/N5 copy. Three new
>   v2-scoped hooks (`useMeasurementCatalog`, `useMeasurementSetup`,
>   `useSetupTest`). C4 split of `useModalAdapter.js` (2348 → 1742 LOC,
>   -606) extracted constants + bandHelpers + chain mutations + server
>   lifecycle + project CRUD into `hooks/modalAdapter/*`. Legacy
>   `useMeasurementCollection` rewritten as a throwing 410-Gone stub +
>   smoke test; legacy `<CollectPanel>` deleted. **43 new Phase 2b
>   tests, all green; 389/389 PianoidTunner tests pass.** Note: deeper
>   `ModalAdapter.jsx` panel-extract (Setup/Tracking/Apply body splits)
>   deferred to Phase 2c when Project subpanel slim-down naturally
>   reshapes the Setup section. Gate 3 sign-off pending UI smoke
>   verification (live-stack `/test-ui` not run by this agent).
> - **Phase 2c — Project subpanel slim + streaming log + branch
>   (PENDING).** Slim Project subpanel + `<CollectionLog>` component +
>   remaining 410 Gone for `/copy` + `/create_from_zip` + per-Measurement
>   `/collect/*` v2 routes.
>
> The original combined-scope is retained below for historical reference.

**Scope (original — split during execution).**
- Build the new `<CollectionSubpanel>` with five sections (§4.1). *(Phase 2b — DONE)*
- Build the ONE `<SetupTest>` shared component used in Sections B + C
  + the pre-flight banner (Q4 + Q5). *(Phase 2b — DONE as `<SetupTestPanel>` + `<SetupTestBanner>` thin wrapper)*
- Build the `<CalibrationCriteriaEditor>` (Section E). *(Phase 2b — DONE as `CalibrationCriteriaSection.jsx` with add/remove rows + Reset to defaults)*
- Wire the Setup Test backend endpoint (`POST /modal/measurements/{id}/setup_test`)
  end-to-end through `signal_processor.validate_calibration_quality`,
  with N3 single-latest overwrite semantics. **DONE in Phase 2a** — see
  `pianoid_middleware/modal_adapter/setup_test_engine.py`. Note: the
  actual per-criterion measurement uses a dispatch table keyed by
  `criterion_id` rather than a single `validate_calibration_quality`
  call (the spec's wording was a placeholder for the analyser; the
  implementation calls `CalibrationValidatorV2.validate_cycle` for the
  alignment/cycle-level metrics and computes channel-level metrics
  directly from the recorded raw signal).
- Move the `MappingEditor` from Setup subpanel to Collection > General;
  leave a read-only "Inspect mapping in Collection →" link in Setup. *(Phase 2b — `MappingEditor` instance now in `GeneralSection.jsx`; legacy Setup-subpanel mapping editor stays in place pending Phase 2c full Setup-panel rework — see Phase 2b implementation notes)*
- Add the **Unlock with warning** button to the Collection subpanel
  header (N4). *(Phase 2b — DONE as `<UnlockMeasurementDialog>` + persistent header button when `acquisition_locked === true`; verbatim N4/N5 copy)*
- **N8 hard cutover.** Delete the v1 `/modal/collect/*` legacy wrappers
  in the same commit that ships the new frontend. Replace each with a
  `410 Gone` handler pointing at the v2 endpoint. Frontend stops calling
  the v1 surface in this same release. **Backend half DONE in Phase 2a**
  (`collection_routes.py` rewritten to 410 handlers; `routes.py
  /collect/health` also retired to 410; `/modal/measurements/active_session`
  added as the single legacy survivor per §3.4 line 670). Frontend
  half pending in Phase 2b.
- Frontend dual-mode (v1+v2) code-path is removed in this phase. *(Phase 2b — DONE: legacy `<CollectPanel>` deleted; `useMeasurementCollection` rewritten as throwing 410-Gone stub with smoke test verifying any leftover import call surfaces immediately rather than silently calling dead endpoints)*

**Gate 3 — sign-off.** UI smoke test via `/test-ui` (audio_off mode for
UX, audio_on Phase 7 for the Setup Test end-to-end):
- All five accordions expand/collapse, fields edit and save.
- Lock chip appears when `acquisition_locked: true`; criteria editor
  remains editable in that case; all other fields read-only.
- Setup Test runs from each of the three surfaces, produces identical
  reports, **overwrites the previous result** (N3 — no history grows).
- Pre-flight banner correctly gates Start Collection on
  `pass / warn / fail`.
- Unlock-with-warning button surfaces the snapshot-preservation copy
  (N4 + N5) and unlocks `setup/*` editors on confirm.
- Every retired v1 endpoint returns `410 Gone` with a body pointing at
  its v2 replacement (N8).

### Phase 3 — Project Subpanel Slim-Down + Branching (~3–5 days)

**Scope.**
- Strip the mapping editor + acquisition fields from the Project
  subpanel.
- Add the Parent Measurement card at the top.
- Replace Copy From with Branch (UI + backend `POST /modal/projects/<old>/branch`).
- Update ProjectBrowserDialog row layout to surface the parent
  Measurement.

### Phase 4 — Streaming Progress Messages (~1 day)

**Scope.**
- Add the `messages` ring buffer to `CollectionSession` (256-entry cap,
  thread-safe append).
- Plumb `recorder` / `collector` / `signal_processor` log calls into the
  buffer (an adapter `MessageLogger` that wraps a stdlib `Logger.handle`).
- Surface in `GET /modal/measurements/{id}/collect/status`.
- Build the `<CollectionLog>` frontend component and mount under the
  existing progress bar.

### Phase 5 — Light SDL3.dll Share (~2 days, Gate 4)

**Scope.**
- Identify the two `SDL3.dll` copies (one in `pianoidCuda` install dir,
  one shipped with the new in-tree `sdl_audio_core` build artefact).
- Update the `build_pianoid_cuda.bat` post-build step to copy a SINGLE
  `SDL3.dll` into both target locations (or symlink — but Windows
  symlinks need admin or developer mode; copy is safer).
- Add a build-time assertion that both consumers see the same SDL3
  version.
- Update `BUILD_SYSTEM.md` to document the shared DLL.

**Gate 4 — sign-off.** Synthesis perf benchmark (test-perf-audio-on) +
mic-loopback A1 (test-ui audio_on Phase 7) — neither regresses. Three
runs. Verify a single `SDL3.dll` is present (no duplicate) under
`PianoidCore/.venv/Lib/site-packages/`.

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Migration corrupts an existing Project's data** | Medium | High | Roll-back tarball (mandatory), dry-run default, verification pass post-migration, manual escape hatch (server doesn't crash on migration failure). |
| **`sdl_audio_core` build fails on a clean machine after move into PianoidCore** | Medium | Med | Phase 0 explicit gate on Belarus end-to-end pass before any data-model work. CI build verification on a fresh checkout. |
| **Audio device contention regressed by Phase 0** | Low-Med | High | Phase 0 keeps the dev-mastop pause/resume dance verbatim — no driver-merge attempt in this phase. End-to-end test on Belarus must pass byte-equal against pre-port. |
| **Setup Test surface-coverage drift** (the "same test, three surfaces" promise breaks because the three call sites diverge) | Med | Med | Single shared backend endpoint + single shared frontend `<SetupTest>` component; the three surfaces only differ in their wrapping CTA. Snapshot test on the three rendered button variants. |
| **Measurement entity gets abused as "anything I want to store at acquisition time"** | Medium | Med | Lock semantics — `setup/*` is sealed alongside `raw/`. No "edit this audio device after the fact" footgun. |
| **Multi-week refactor — parallel-agent coordination drift** | Med | Med | Each phase has its own MODULE_LOCKS.md acquire; sub-agents stop at the phase boundary; the gate sign-offs are explicit human-in-the-loop checkpoints. |
| **Frontend dual-mode (v1+v2) bug surface during Phase 1** | Med | Low-Med | Cap the dual-mode window to Phase 1 only — the v1 frontend code path is deleted in the Phase 2 ship commit (alongside the v1 backend wrappers per N8). Auto-migrate at server start fires the moment Phase 2 ships, so any v1 project on disk becomes a v2 Measurement+Project pair before the user can open it. |
| **`branched_from` provenance diverges from reality** (user re-runs ESPRIT in the source after branching) | Low | Low | `branched_from` is a name string, not a snapshot. Documentation makes clear it's an informational hint, not a binding contract. |
| **Light SDL3.dll share breaks the synthesis hot path** | Low | High | Phase 5 has a synthesis perf gate (Gate 4). If the share regresses, revert the build-step change — dual DLLs is the fall-back. |
| **`measurements_base` discovery on Linux/macOS** (today's defaults are Windows-paths) | Low | Low | `$PIANOID_MEASUREMENTS_DIR` env var; defaults documented per OS in BUILD_SYSTEM.md. |
| **Snapshot disk bloat** (N5 — every Project carries a deep-copy of `setup/*`) | Low | Low | The setup JSONs are small (~5–20 KB total). Even a project corpus of hundreds adds <10 MB total. No mitigation needed; document the expected footprint in BUILD_SYSTEM.md. |
| **Snapshot drift confuses the user** (N5 — Project's snapshot disagrees with parent Measurement after unlock + edit) | Med | Low-Med | Project subpanel surfaces a "Setup last edited 3 days ago in parent (post-snapshot) — view diff" chip when `parent.setup ≠ project.measurement_snapshot`. Diff is read-only. The Project is not invalidated; the snapshot remains authoritative for ESPRIT. |
| **Orphan Measurements accumulate** (N6 — Measurements never auto-delete, the user forgets they exist) | Low-Med | Low | Measurement-list view sorts by "last accessed" and surfaces a count of "0 linked Projects" so orphans are visible. No automatic cleanup — disk hygiene is the user's call. |
| **Hard cutover (N8) breaks an external integration** (some unknown caller hits `/modal/collect/start` after Phase 2) | Low | Med | The `410 Gone` body explicitly names the replacement endpoint and links the proposal section. Release notes for Phase 2 list every retired endpoint. The transition window in Phase 1 (legacy wrapper alive) gives integrators one release to migrate. |

---

## 8. Sign-Off Gates (Recap)

| Gate | After phase | Verification surface |
|---|---|---|
| **Gate 1** | Phase 0 (RR port) | Belarus end-to-end byte-equal vs pre-port. Synthesis perf no regression. Three runs. |
| **Gate 2** | Phase 1 (Measurement entity + migration) | Migration verified on Belarus + 2 real + 1 synthetic + 1 legacy-no-mapping project. Post-migration ESPRIT byte-equal vs pre-migration. |
| **Gate 3** | Phase 2 (Collection UX) | UI smoke test on all five sections + lock semantics + Setup Test in three surfaces. Pre-flight banner gates correctly. |
| **Gate 4** | Phase 5 (SDL3.dll share) | Synthesis perf benchmark + mic-loopback A1 — neither regresses. Single SDL3.dll on disk. |

Phase 3 + Phase 4 are low-risk and ship without explicit gates beyond the
standard `/dev` workflow self-test.

---

## 9. Cross-References

- **Modal Adapter pipeline architecture (analysis side):** [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../guides/MODAL_ADAPTER_GUIDE.md)
- **Today's collection REST surface (will be replaced):** [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../modules/pianoid-middleware/MODAL_COLLECTION.md)
- **Today's REST API:** [`docs/modules/pianoid-middleware/REST_API.md`](../modules/pianoid-middleware/REST_API.md)
- **Pianoid driver architecture:** [`docs/modules/pianoid-cuda/AUDIO_DRIVERS.md`](../modules/pianoid-cuda/AUDIO_DRIVERS.md)
- **Build system (impacted by Phase 0 + Phase 5):** [`docs/architecture/BUILD_SYSTEM.md`](../architecture/BUILD_SYSTEM.md)
- **Frontend canonical "Settings section" pattern (lock + Save):** `D:\repos\PianoidInstall\PianoidTunner\src\modules\ModalAdapter.jsx:822-1003` (the Setup section's accordions — pattern carried forward to the new Collection sections)
- **Backend collection orchestrator (pre-Phase 0 location):** `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\collection_engine.py`
- **`_room_response_bootstrap.py` (target for deletion in Phase 0):** `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\_room_response_bootstrap.py`
- **RoomResponse source-of-truth (read-only reference until Phase 0 lands):** `D:\repos\RoomResponse\` — `RoomResponseRecorder.py`, `DatasetCollector.py`, `generate_missing_averages.py`, `MicTesting.py`, `signal_processor.py`, `sdl_audio_core/`

---

## 10. Open Questions

**All design questions raised by the original draft have been answered.**

The eight open questions surfaced during the original write-up
(name/id collision handling, cross-machine portability, Setup Test
retention, acquisition-lock auto-trigger, Project lifecycle on parent
unlock, Measurement DELETE policy, `recording_mode` scope, backwards-
compat window) plus the eight design questions raised during the
proposal review (Q1–Q8) have all been resolved by the user on
2026-05-10. The decisions are baked into §1–§7 above as authoritative
spec; cross-references inline use the Q1–Q8 / N1–N8 tags so each
behaviour can be traced back to its decision.

| Tag | Decision (one-line) | Section(s) |
|---|---|---|
| Q1 | Settings persistence is project-level (subsumed by Q2) | §1, §2 |
| Q2 | Measurement is a first-class entity | §1, §2, §3, §4, §5, §6 |
| Q3 | Project-time averaging from raw — Project owns averaging config | §1, §2.4 |
| Q4 + Q5 | ONE shared `<SetupTest>` across 3 surfaces | §1, §2.5, §4.1, §6 (Phase 2) |
| Q6 | `sdl_audio_core` source moves into PianoidCore | §1, §6 (Phase 0) |
| Q7 | Light SDL3.dll share between Pianoid + RR drivers (no full driver merge) | §1, §6 (Phase 5) |
| Q8 | Structured `messages: [...]` streaming progress | §1, §3.3, §4.3, §6 (Phase 4) |
| N1 | Block duplicate Measurement names on creation (names = unique IDs) | §1, §2.2 invariants, §2.3.1, §3.1, §5.1 |
| N2 | Store BOTH `measurement_id` AND absolute path with env-var-root fallback | §1, §2.2 invariants, §2.3.6 |
| N3 | Setup Test single-latest only (overwrite, no history) | §1, §2.2 layout, §2.5, §3.1 |
| N4 | Auto-lock after FIRST scenario; "Unlock with warning" button always available | §1, §2.2 invariants, §3.1, §4.1 header, §5.2, §6 (Phase 2) |
| N5 | Project SNAPSHOTS Measurement setup at branch-time | §1, §2.2 invariants, §2.3.6, §3.2, §5.2.1, §7 |
| N6 | Measurement NEVER auto-deleted on Project delete | §1, §3.1, §3.2 |
| N7 | `recording_mode` is per-Measurement only | §1, §2.3.4, §3.1, §4.1 Section D |
| N8 | Hard cutover for v1 `/modal/collect/*` at Phase 2 (410 Gone) | §1, §3.2, §3.4, §6 (Phase 1 transition + Phase 2 cutover) |

### 10.1 New Questions Surfaced During the Bake-In Pass

None. The 16 decisions cover the full set of design ambiguities the
proposal raised. Implementation-time questions (e.g. "what exactly is
the slug-normalisation rule for `measurement_id`?", "what's the maximum
length of `measurement_id` on Windows path-limit grounds?") are
delegated to the Phase 1 `/dev` agent and tracked as in-flight
implementation notes, not as design questions.

---

## 11. Document Lineage Note

This proposal is the **single source of truth** for the Modal Adapter
Measurement-entity refactor. Per the single-source-of-truth rule, all
still-relevant preparation context (the parameter-by-parameter cross-walk
from the RR `sdl_audio_core` / `RoomResponseRecorder` API surface, the
side-by-side audit of the two SDL3 driver implementations, the
Stream-2/3 inventory of the ~3700-LOC port, the data layout of the
existing `recorderConfig.json`, the multichannel_config field list, the
voice_coil sub-block) lives in the body of THIS document.

There are no companion design proposals; nothing else needs to be read
to start work. The Phase 0 `/dev` agent should treat this proposal as
the single artefact to follow.
