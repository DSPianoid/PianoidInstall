# Dev Session Log

- **Agent:** dev-impulse-chart
- **Task:** Bundled Collection UX polish — (1) impulse-shape ECharts preview in Impulse section, (2) relocate `volume` from Series → Impulse (schema + UI), (3) remove `recording_mode` user field entirely (series_config schema + UI).
- **Started:** 2026-05-12T14:42:25Z
- **Plan file:** None (task brief from user/orchestrator)
- **Predecessor:** Phase 2c wrap-up `7590b2a` on PianoidInstall + `2029e21` on PianoidTunner + `ca00f4f` on PianoidCore + `a3212d2` on PianoidTunner (PIANOID_URL hotfix).
- **Status:** In Progress

## Actions

[STEP-0-COMPLETE] 2026-05-12T14:42:25Z

### Step 0: Initialize Session — 2026-05-12T14:42:25Z

- Agent ID `dev-impulse-chart`. (Not reusing dev-msmtui-fc — that Phase 2c session is closed; this is a separate bundled UX task.)
- Session log created.
- WIP entry registered.
- MODULE_LOCKS.md empty (verified).

### Step 1: Understand Context — 2026-05-12T14:42:25Z

[READ] 2026-05-12T14:42:25Z path=D:/repos/RoomResponse/gui_calibration_impulse_panel.py
[READ] 2026-05-12T14:42:25Z path=PianoidCore/pianoid_middleware/modal_adapter/measurement/recorder.py (impulse-generation formula)
[READ] 2026-05-12T14:42:25Z path=PianoidCore/pianoid_middleware/modal_adapter/measurement_entity.py (default_series_config / default_impulse_config)
[READ] 2026-05-12T14:42:25Z path=PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py (`_build_recorder_config_from_measurement` stitching)
[READ] 2026-05-12T14:42:25Z path=PianoidCore/pianoid_middleware/modal_adapter/setup_test_engine.py (separate stitching path)
[READ] 2026-05-12T14:42:25Z path=PianoidTunner/src/modules/panels/collection/ImpulseSection.jsx
[READ] 2026-05-12T14:42:25Z path=PianoidTunner/src/modules/panels/collection/SeriesSection.jsx
[GREP] 2026-05-12T14:42:25Z pattern=recording_mode path=PianoidCore/pianoid_middleware/modal_adapter

**Findings:**

1. **RoomResponse impulse shape "chart" is NOT a configured-preview chart** — `gui_calibration_impulse_panel.py` plots recorded waveforms (the actual captured calibration impulses). The proposal §4.1 mentions "Calculated waveform preview — small ECharts plot — client-derived from current values — Optional Phase 2.5 (no backend dep)" which is the user's actual ask. This is a NEW chart (not "similar to RoomResponse" in the sense of copying), with the data path derived client-side from the recorder formula.

2. **Recorder impulse formula is simple, deterministic, pure-math** (recorder.py:503-549). Three forms:
   - `sine` — `sin(2π·f·t)` with linear fade in/out (`fade_samples` linear ramps on both ends), scaled by `volume * 0.3`
   - `square` — constant 1.0 with linear fade in/out, scaled by `volume * 0.3`
   - `voice_coil` — `np.ones(N)` with the LAST `fade_samples` samples replaced by `pullback_samples`: zeros for the first `fade_samples//3`, then a linear ramp from `-0.5 → 0` for the remaining `fade_samples - fade_samples//3`. Scaled by `volume * 0.3`.

   **NOTE:** the in-tree recorder does NOT consume the Phase 2 `voice_coil_config` sub-block (init_pos_ms / positive_ms / gap_ms / negative_ms / pullback_amplitude / init_pos_amplitude). That sub-block is forward-looking. The chart must render the recorder's actual current formula, not the spec.

3. **Implementation choice: (a) frontend computes shape from params.** Pure math, deterministic, ECharts on the current `staged` values gives live updates with no debounce / no backend round-trip. Choosing (a) over (b) per the task brief's recommendation logic.

4. **Volume location:**
   - Currently in `series_config.json` (per proposal §2.3.4 + `measurement_entity.default_series_config()` line 292).
   - User wants it moved to `impulse_config.json`.
   - Three call sites need updating:
     - `measurement_entity.default_impulse_config()` — add `"volume": 0.4`.
     - `measurement_entity.default_series_config()` — remove `"volume"`.
     - `collection_engine._build_recorder_config_from_measurement()` — read volume from impulse first; legacy fallback: also read from series for old saved configs that still have it there.
     - `setup_test_engine._build_recorder_cfg_from_measurement()` — same legacy-fallback pattern.
   - UI: move `<TextField label="volume">` from SeriesSection to ImpulseSection.

5. **recording_mode removal:**
   - Currently in `series_config.json` + UI radio in SeriesSection.
   - Internal `take_record(mode='calibration')` calls in `setup_test_engine.py` + `recorder.py:take_record_calibration()` + DatasetCollector's `recording_mode` constructor param are NOT user-facing. SetupTestEngine hardcodes `mode="calibration"` internally regardless. Removing the user field does NOT affect these internal paths.
   - DatasetCollector takes `recording_mode` as a CONSTRUCTOR param (line 92). That comes from the stitched config dict. If we strip `recording_mode` from series_config + stitching, DatasetCollector falls back to its `"standard"` default — exactly what the user wants (only-standard mode for user-driven collection).
   - SetupTestEngine's stitching ALSO reads `recording_mode` (line 221). Need to remove that line — SetupTestEngine then calls `take_record(mode='calibration', ...)` explicitly anyway, so this is a no-op.
   - Migration policy: strip silently on load (the field is meaningless after removal). Recommended.

**No PAUSE triggers:**
- (1) Impulse formula is trivial; no backend dep; option (a) clear.
- (2) Volume relocation is mechanical (3 backend files + 2 JSX files). Backwards-compat via legacy-fallback in stitchers.
- (3) recording_mode removal is clean — SetupTestEngine's internal calibration path is untouched.

Proceeding to Step 1b.

### Step 1b: Environment Control — 2026-05-12T14:42:25Z

[STEP-1B-VENV-CHECK] interpreter=D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe

User has the stack running (testing Phase 2c). I will NOT kill ports mid-task — CRA will hot-reload as I edit. Step 10a Phase 1 kills all ports per the codified rule.

[LOCK ACQUIRED] PianoidCore/pianoid_middleware/modal_adapter/measurement_entity.py
[LOCK ACQUIRED] PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py
[LOCK ACQUIRED] PianoidCore/pianoid_middleware/modal_adapter/setup_test_engine.py
[LOCK ACQUIRED] PianoidTunner/src/modules/panels/collection/ImpulseSection.jsx
[LOCK ACQUIRED] PianoidTunner/src/modules/panels/collection/SeriesSection.jsx
[LOCK ACQUIRED] PianoidTunner/src/modules/panels/collection/ImpulseShapeChart.jsx (new)

### Step 4-7: Implementation + tests — 2026-05-12T15:50:00Z

**Backend (PianoidCore):**
- [EDIT] file=PianoidCore/pianoid_middleware/modal_adapter/measurement_entity.py — `default_impulse_config()` adds `volume: 0.4`; `default_series_config()` removes `volume` + `recording_mode`. Docstrings updated with the dev-impulse-chart context.
- [EDIT] file=PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py — `_build_recorder_config_from_measurement()` reads `volume` from impulse first with legacy series fallback; no longer surfaces `recording_mode` from series_config.
- [EDIT] file=PianoidCore/pianoid_middleware/modal_adapter/setup_test_engine.py — same volume + recording_mode treatment in `build_recorder_config()`.
- [EDIT] file=PianoidCore/tests/integration/test_measurement_collect_routes.py — `test_setup_files_stitched_into_overrides` updated to canonical schema; 4 new tests added (legacy-volume fallback @ route + helper levels, volume relocation canonical path, recording_mode silently ignored).

**Frontend (PianoidTunner):**
- [EDIT] file=PianoidTunner/src/modules/panels/collection/ImpulseShapeChart.jsx (NEW, 290 LOC) — pure-math ECharts preview, recorder formula 1:1, downsamples >4096 samples via stride, volume * 0.3 headroom shown.
- [EDIT] file=PianoidTunner/src/modules/panels/collection/ImpulseSection.jsx — added `volume` TextField + mounted `<ImpulseShapeChart>`. Legacy fallback for `volume` in `series_config` honoured at section-render time.
- [EDIT] file=PianoidTunner/src/modules/panels/collection/SeriesSection.jsx — removed `volume` TextField + `recording_mode` radio block + accordion chip. `cleanFromManifest` strips both retired fields on load so they don't survive the next Save.
- [EDIT] file=PianoidTunner/src/components/__tests__/CollectionSubpanel.test.jsx — added jest.mock for echarts-for-react (jsdom canvas limitation). Updated for the new chart in ImpulseSection.
- [EDIT] file=PianoidTunner/src/modules/panels/collection/__tests__/ImpulseShapeChart.test.jsx (NEW, 11 tests) — generator math per form + invert + volume scaling + downsampling + chart structural assertions + live update.
- [EDIT] file=PianoidTunner/src/modules/panels/collection/__tests__/ImpulseSection.test.jsx (NEW, 4 tests) — volume field present + chart mounted + legacy fallback + Save submits volume.
- [EDIT] file=PianoidTunner/src/modules/panels/collection/__tests__/SeriesSection.test.jsx (NEW, 5 tests) — volume + recording_mode removed; legacy retired-field stripping; derived calcs still render.

[FILE-LOC] PianoidTunner/src/modules/panels/collection/ImpulseShapeChart.jsx before=0 after=290
[FILE-LOC] PianoidTunner/src/modules/panels/collection/ImpulseSection.jsx before=297 after=327 (+30, +volume + chart)
[FILE-LOC] PianoidTunner/src/modules/panels/collection/SeriesSection.jsx before=300 after=257 (-43, removed UI)

**Verification:**
- 224 backend tests pass (4 new + 220 pre-existing).
- 429 frontend tests pass across 40 suites (20 new dev-impulse-chart + 409 pre-existing Phase 2c baseline).

### Step 8: Update Documentation — 2026-05-12T15:55:00Z

[EDIT] file=docs/proposals/modal-adapter-measurement-entity-2026-05-10.md — §2.3.3 adds `volume: 0.4` + dev-impulse-chart relocation note; §2.3.4 removes `volume` + `recording_mode` from JSON schema + updated text under "schema deltas" callout (legacy fallback semantics + N7 retired).
[EDIT] file=docs/guides/MODAL_ADAPTER_GUIDE.md — Section table row C/D updated to reflect volume + chart in Impulse + recording_mode removal in Series. Added 3 new subsections describing the configured-impulse ECharts preview (formula by form + voice_coil mismatch warning), volume relocation backwards-compat, and recording_mode removal rationale.
[EDIT] file=docs/modules/pianoid-middleware/MODAL_COLLECTION.md — stitching section updated with the new precedence (impulse first, series fallback) + `recording_mode` ignored note + voice_coil chart-vs-recorder mismatch warning.

[STEP-8-COMPLETE] 2026-05-12T15:55:00Z docs_touched=docs/guides/MODAL_ADAPTER_GUIDE.md,docs/modules/pianoid-middleware/MODAL_COLLECTION.md,docs/proposals/modal-adapter-measurement-entity-2026-05-10.md

### Step 9: Merge feature branches into dev — 2026-05-12T15:58:00Z

[BASH-CALL] 2026-05-12T15:58:00Z git -C PianoidCore merge feature/dev-impulse-chart --no-ff
[BASH-RETURN] 2026-05-12T15:58:00Z exit_code=0
PianoidCore dev tip: 0553910 (merge of feature/dev-impulse-chart)

[BASH-CALL] 2026-05-12T15:58:00Z git -C PianoidTunner merge feature/dev-impulse-chart --no-ff
[BASH-RETURN] 2026-05-12T15:58:00Z exit_code=0
PianoidTunner dev tip: b1c2364 (merge of feature/dev-impulse-chart)

### Step 10a Phase 1 — 2026-05-12T16:00:00Z

1. Step 8 docs done (above).
2. Lock audit: every dirty file appeared in this agent's lock row at edit time. No retroactive lock additions needed.
3. Commits:
   - PianoidCore feature: 1f4e019 → merged as 0553910
   - PianoidTunner feature: 990116b → merged as b1c2364
   - Docs commit on root: see below.
4. Release locks (this entry):

[LOCK RELEASED] PianoidCore/pianoid_middleware/modal_adapter/measurement_entity.py
[LOCK RELEASED] PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py
[LOCK RELEASED] PianoidCore/pianoid_middleware/modal_adapter/setup_test_engine.py
[LOCK RELEASED] PianoidTunner/src/modules/panels/collection/ImpulseSection.jsx
[LOCK RELEASED] PianoidTunner/src/modules/panels/collection/SeriesSection.jsx
[LOCK RELEASED] PianoidTunner/src/modules/panels/collection/ImpulseShapeChart.jsx

5. Kill ports + verify clear:

[BASH-CALL] 2026-05-12T16:02:00Z netstat sweep + taskkill on Pianoid ports
[BASH-RETURN] 2026-05-12T16:02:00Z exit_code=0
Killed PIDs 80588 (port 5001 — modal_adapter_server) + 83700 (port 3000 — CRA dev server) + 81620 (port 3001 — launcher). All four Pianoid ports verified clear (no LISTENING processes).

**Final SHAs:**
- PianoidCore dev tip: `0553910` (merge of feature/dev-impulse-chart)
  - Feature commit: `1f4e019`
- PianoidTunner dev tip: `b1c2364` (merge of feature/dev-impulse-chart)
  - Feature commit: `990116b`
- PianoidInstall (docs) HEAD: `dbe8717` ([dev-impulse-chart] docs: bundled Collection UX polish + lock release)

[STEP-10A-PHASE-1] 2026-05-12T16:02:00Z commit=dbe8717

**STOP HERE.** Phase 1 wrap-up done. Stack DOWN — user starts fresh
manually via `start-pianoid.bat` to test the new chart + the volume
relocation + the recording_mode removal end-to-end on hydrated
PlyWood projects.


