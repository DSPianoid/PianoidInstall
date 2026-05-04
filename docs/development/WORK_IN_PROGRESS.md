# Work in Progress

## Active Dev Sessions

| Agent | Task | Log | Started | Status |
|-------|------|-----|---------|--------|
| dev-b9dd | Modal Adapter grid-layout mode (MVP, line-mode backward compat, per-chain heatmap, defer bridge-from-grid) | [log](logs/dev-b9dd-2026-05-04-182100.md) | 2026-05-04 | In Progress |

---

## Modal Adapter Grid Layout MVP follow-ups (2026-05-04)

**Status:** Landed in dev-b9dd (`feature/modal-adapter-grid-layout`). High #1 (P1
contract validator on `point_coordinates` keys) was folded in before commit. The
following findings from the same /review pass were deferred per user direction.

### High (waived for this PR — schedule before next touch)

- **C4 RED file growth (waived).** Five already-RED files grew further this PR:
  - `pianoid_middleware/modal_adapter/modal_adapter.py` 2981 → 3106 LOC
  - `PianoidTunner/src/hooks/useModalAdapter.js` 1378 → 1479 LOC
  - `PianoidTunner/src/modules/ModalAdapter.jsx` 1133 → 1242 LOC (1211 from grid + 31 from accordion)
  - `pianoid_middleware/modal_adapter/esprit/mode_tracking.py` 1215 → 1269 LOC
  - `PianoidTunner/src/components/StabilizationDiagram.jsx` 2231 → 2252 LOC

  Pre-existing debt; user explicitly waived for this PR. **Schedule:** before the
  next feature touching ANY of these files, extract one helper:
  - **Recommended first split:** `get_grid_heatmap_data` → new
    `pianoid_middleware/modal_adapter/grid_heatmap.py` (~120 LOC out of `modal_adapter.py`)
  - **Recommended second split:** `useModalAdapter.js` grid-mode state +
    setters + `getGridHeatmap` fetcher → new `useGridLayout.js` hook (~150 LOC out)

### Medium (deferred follow-ups)

- **Heatmap error visibility.** `useModalAdapter.js:getGridHeatmap` and
  `GridHeatmapInset.jsx` swallow backend error messages — heatmap shows generic
  "no data" for everything (no tracking, wrong layout, chain out of range,
  network error). Surface the backend error string. ~10 LOC fix in both files.

- **Grid cell keyboard a11y.** Cells in `GridLayoutEditor.jsx:241-269` aren't
  keyboard-accessible (no `tabIndex`, `role="button"`, `aria-label`,
  `onKeyDown`). Add per project Frontend UI Standards in `.claude/CLAUDE.md`
  (the "Accessibility Baseline" section explicitly requires keyboard nav for
  all interactive elements).

- **Bulk shape buttons have no undo.** All On / All Off / Invert wipes the
  entire mask in one click — easy to lose a carefully-painted custom shape.
  Add a local undo stack OR a confirmation step.

- **Component-semantics fix.** `GridLayoutEditor.jsx:195-199` uses
  `<ToggleButtonGroup exclusive>` for action buttons (All On / All Off /
  Invert) — semantically these are independent actions, should be
  `<ButtonGroup>` not `<ToggleButtonGroup>`. The component renders correctly
  but the DOM/a11y semantics are wrong.

### Low (cleanups)

- **S3 — row-major-cell-walk duplication.** Six instances of the row-major
  walk over `cell_mask` populated cells across frontend + backend
  (`GridLayoutEditor.jsx`, `useModalAdapter.js`, `modal_adapter.py`,
  `mapping.py`, the new `_validate_grid_layout`, and the GRID-button init in
  `ModalAdapter.jsx`). Extract a `populated_cells_in_row_major(cell_mask)`
  helper on each side of the wire.

- **A4 — frontend default grid params inlined.** The "switch to GRID"
  initializer in `ModalAdapter.jsx:583-616` hardcodes `[4, 4]` shape +
  `10mm` spacing + all-cells-populated. Either codify in `MappingConfig`
  module-level constants (preferred — single source of truth) OR document.

- **Test gap — line-mode payload bit-identicality.** No test asserts that
  `submitChannelMapping` for `layout_type="line"` produces a JSON payload
  bit-identical to the pre-grid contract. Add a small HTTP-payload roundtrip
  test in `tests/integration/test_modal_pipeline_payload.py` to lock in the
  backward-compat guarantee.

### Cosmetic note (not from this PR)

- **Pre-existing `Box children` PropType warning.** The browser console fires
  a `Warning: Failed prop type: Invalid prop 'children' supplied to
  ForwardRef(Box), expected a ReactNode. at ModalAdapter` warning on every
  Modal Adapter render. Verified to predate this PR (fires before any new
  code path executes on first page load). Track separately if it bothers
  anyone — not a regression introduced by grid layout.

---

## Modal Adapter create_from_zip + auto-averaging (2026-05-04)

**Status:** Landed in dev-0239. Follow-ups deferred per user direction.

The new `POST /modal/projects/create_from_zip` endpoint (multipart upload,
streamed via Werkzeug) handles both `.pianoid-project` archives and raw
measurement-data zips in one call. For measurement-data zips it auto-extracts
to `D:\modal_measurements\<name>\` (or `$PIANOID_MEASUREMENTS_DIR`) and runs
the canonical RoomResponseRecorder averaging pipeline (validate → align →
normalize → average → truncate-with-fadeout) on every scenario lacking
`averaged_responses/`. Idempotent — pre-existing averages are never
overwritten. Frontend "Import Project" button now smart-routes by file
extension; success alert reports the averaging breakdown.

**Implementation:** `PianoidCore/pianoid_middleware/modal_adapter/`
`scenario_averager.py` (new, ~370 LOC) + `modal_adapter.py` +
`routes.py`; `PianoidTunner/src/hooks/useModalAdapter.js` +
`src/modules/ModalAdapter.jsx`; `docs/guides/MODAL_ADAPTER_GUIDE.md`.

**Tests:** 27 pass (10 new in `tests/integration/test_scenario_averager.py`,
17 in `tests/integration/test_modal_create_from_zip.py` of which 2 new).

### Deferred follow-ups

- **Medium #2 — Doc rot in REST API JSON example.** The sample JSON in
  `docs/guides/MODAL_ADAPTER_GUIDE.md` "REST API → Project Import /
  Create-from-Zip" block does NOT include the `averaging_summary` field
  in the `create_from_zip` response example, but the live endpoint
  always returns it. ~5 LOC doc fix to add the field to the example
  alongside the existing `name`/`path`/`extracted_path`/`detected_format`
  keys. Standalone — no code touch required.

- **Medium #3 — Failed-averaging scenarios silently dropped.** When the
  averager returns `status="error"` for a scenario, that scenario
  doesn't get `averaged_responses/` written, so the downstream
  `_discover_roomresponse_scenarios` discovery skips it. The response
  shape exposes `averaging_summary.errors` (count) and
  `averaging_summary.failed_scenarios` (list of `{scenario, error}`),
  but `scenario_indices` only contains the scenarios that DID land in
  the project. The two are not cross-correlated in the UI — a user
  could see "Scenarios imported: 28" + "Averaging errors: 2" and not
  immediately know WHICH scenario indices got dropped. Recommend
  adding `dropped_due_to_averaging_failure: [scenario_idx_list]` to
  the response shape (parsed from `failed_scenarios` by mapping
  scenario folder name → integer via the same regex used by
  `_extract_scenario_index`). ~10 LOC + 1 test.

- **Medium #4 — `routes.py` is 971 LOC (29 under the project's RED
  threshold of 1000 LOC).** Adding `create_from_zip` brought it close
  to the cliff. Plan a split (e.g. `routes_projects.py` for the
  project lifecycle endpoints, `routes_pipeline.py` for the
  ESPRIT/tracking/feedin endpoints, `routes.py` keeping the blueprint
  + shared helpers) BEFORE the next routes-touching session. No
  immediate user-facing impact; structural debt only.

- **Low #1 — Cross-repo bootstrap probe gap.** `scenario_averager.py`
  imports `signal_processor` and `calibration_validator_v2` lazily
  per-scenario. If the sibling RoomResponse repo is at the right path
  but those specific module names get renamed/moved upstream, every
  scenario in an import would silently fall through with `status=error`
  with no aggregated user-visible warning. Could add a one-time probe
  in `_auto_average_scenarios` that returns a top-level
  `averaging_unavailable: true` flag + skips the whole walk if neither
  module is importable. ~15 LOC.

- **Low #2 — No version/contract assertion against RoomResponse.** The
  averager uses three RoomResponse APIs (`SignalProcessor.average_cycles`,
  `align_cycles_by_onset`, `normalize_by_calibration`) plus
  `CalibrationValidatorV2.validate_cycle` and the
  `validation_results` dict shape. If RoomResponse refactors any of
  these signatures, the averager errors per-scenario without a clear
  diagnostic. Could add a smoke import + interface check at
  modal-adapter-server startup. ~10 LOC.

- **Low #3 — CI without RoomResponse silently skips 4 tests.** The
  `TestCanonicalPipeline` class in `test_scenario_averager.py` is
  `@pytest.mark.skipif(not _HAS_ROOMRESPONSE)`. CI machines without
  the sibling repo will pass with 4 tests skipped. Acceptable today
  (the canonical-pipeline coverage IS sound on dev boxes), but a
  future CI hardening pass should either bootstrap RoomResponse on
  CI or assert the canonical tests aren't skipped.

- **Low #4 — S3 first-hit-rule duplication between
  `_auto_average_scenarios` and `_detect_measurement_source`.** Both
  helpers walk root + first-level subdirs looking for the
  measurement parent. They do agree on ordering today (alphabetical
  sort), but the duplication is a S3 (no-duplication) violation — a
  future refactor should extract a single `_walk_for_measurement_root()`
  helper. ~15 LOC.

- **Low #5 — Multi-line `window.alert` in `ModalAdapter.jsx`.** The
  success alert builds a multi-line `\n`-separated string for
  `window.alert`, which renders as a system modal that's hard to
  copy/paste from. Consistent with the pre-existing pattern in this
  module (e.g. the "name conflict resolved" alert) so not a regression,
  but the long-term direction is MUI Snackbar/Alert with a "View
  details" expand for the averaging summary. Tracked at the
  module-wide level rather than per-handler.

---

## Orchestrator Session Pause — 2026-05-01

User paused all work for a computer restart. Full session state captured at:

**[`orchestrator-session-state-2026-05-01.md`](orchestrator-session-state-2026-05-01.md)**

That file contains: today's commits in chronological order, engine bug cluster status (Bug A + Bug #2/#3 fixed; Bug #1 paused with corrected diagnosis), the immediate-resume decision queue (Bug #1 a/b/c/d call), Modal Adapter integration status (B-0/B-1/B-3 landed, B-2/B-4/B-5/Q4 ports deferred), CLAUDE.md/dev.md reorganization details, memory updates, and stack restart instructions. **Resume here after reboot.**

---

## Mode Parameter Handling Audit (2026-04-29)

**Status:** Session 1 committed. Sessions 2 and 3 pending.

A `/analyse` audit of mode parameter handling produced a 4-pillar report (math/physics, UI routes, debug tools, improvements). Full plan: 3 /dev sessions.

| Session | Scope | Status |
|---|---|---|
| S1 | Bug fixes + doc rot — `/set_mode_parameters` side-effect, `PanoidResult.get_record` axis hardening, DATA_FLOWS / DEBUG_DATA / REST_API / chart_config refresh | **Done** — `8305614` (PianoidCore) + `3ae58fd` (PianoidInstall) |
| S2 | `play_mode` returns populated `PianoidResult`; new accessors `get_mode_state` / `get_synth_audio` / `get_mic_audio` / `set_mic_audio`; chart functions `play_mode_chart_function` + `pure_mode_test_function` collapsed into one `mode_test_function` with `view_mode` + `coupling` selectors | **Done** — `d48a08e` (PianoidCore) |
| S3 | UI/parameter mass/stiffness handling — stiffness + damping rendered read-only in `Mode.jsx`; recompute rule enforced: frequency edit → stiffness, keep mass; mass edit → stiffness, keep frequency; decrement edit → damping; client-side optimistic recompute in `usePreset.js`; backend `parameter_manager` strips derived fields; `pack_for_interface('mode')` returns 5 values | **Done** — `5cc05ee` (PianoidBasic) + `8c8bd92` (PianoidCore) + `2656027` (PianoidTunner) |
| S3-deploy | Stale-wheel hardening: bump PianoidBasic version 0.1.13 → 0.1.14 so pip detects an upgrade on next setup-dev / build_pianoid_cuda; new REST integration test `test_mode_param_independence.py` asserts the rule end-to-end so a future stale-install slip surfaces in CI | **Done** — `c67bdcc` (PianoidBasic) + `24ce350` (PianoidCore) |

### REST / endpoint protocol issues surfaced during S3 verification (2026-04-30)

These were discovered while testing the mode-parameter rule via REST and represent doc rot or unfortunate signatures worth tracking for future cleanup. None are S3-specific; they affect any REST client (CI tests, scripts, or future skills).

- **`/load_preset` request key drift:** the canonical key is `debug_mode` (int 0/1), NOT `use_debug_build` (bool) as documented in some places. The body silently ignores unknown keys, so a wrong-key request loads the release binary. Audit `docs/modules/pianoid-middleware/REST_API.md` for `use_debug_build` references and reconcile with the actual handler in `backendServer.py`. Also: `/load_preset` raises KeyError if `listen_to_midi`, `use_simulation`, `string_iterations`, `audio_on`, `start_right_away`, `sample_rate` are missing — no defaults. Worth adding sensible defaults or documenting the required-fields list explicitly.
- **`PIANOID_USE_DEBUG=1` must be set BEFORE backend launch:** `select_cuda_variant` in `pianoid.py:54` checks `if "pianoidCuda" in sys.modules` to decide which variant to load. `pianoid.py` itself imports `pianoidCuda` at module top, so by the time the backend's `if __name__ == "__main__"` block reads the env var, the release binary is already loaded and the variant cannot switch. The launcher's `/load_preset` `debug_mode=1` flag also can't change this once the process is alive. Already known and tracked under "pianoid.py:54 debug-variant module-load-order trap" in this section's Deferred items, but worth re-emphasising for any test author.
- **`/set_parameter/mode/<idx>/<field>` route does NOT exist:** `backendServer.py:953` exposes `/set_parameter/<type>/<idx>` (no field component); the body shape is `{"<idx>": {"<field>": value}}`. Update REST_API.md mode-update section if it currently shows the per-field URL.
- **`pack_for_interface('mode')` returns a tuple `(dict, 'OK')`** rather than just the dict (`pianoid.py:2474`). Internal callers know this; new test/integration code is likely to drop the tuple unwrap and silently treat `'OK'` as the parameter set. Either rename the helper or document the return shape clearly.
- **Flask auto-reloader hardcoded:** `socketio.run(debug=True)` in `backendServer.py:3016` makes the dev server watch the source tree and restart on any change — including `.pyc` writes. This drops the live `pianoid` global mid-test and breaks any in-process test that hit `/load_preset` then a follow-up endpoint. Workaround: launch backend with `PYTHONDONTWRITEBYTECODE=1`. Real fix: gate `debug=True` behind an env var (`PIANOID_FLASK_DEBUG=1` or similar), default to `debug=False`.

### Deferred follow-ups

- ~~**Backend parameter safety net (post dev-2706)**~~ — **FIXED 2026-05-03 (dev-9a47).** `parameter_manager.py` now exposes `validate_engine_param(kind, field, value)` and raises `ParameterRangeError` (a `ValueError` subclass) with a structured message. REST handlers in `backendServer.py` catch it and return HTTP 400; WS handlers emit `error` with `code: "parameter_range_error"`. Final guard set: `mode.mass_inv <= 0`, `(excitation|gauss).sigma <= 0`, `mode.frequency < 0`, `mode.decrement < 0`, plus a universal NaN/Inf guard on every numeric field (5th catastrophic predicate, applies to all parameter types). Wired into `update_parameter` ('mode', 'excitation', 'gauss' branches), `update_pitch_excitation` (per-pitch curve path), and `/set_mode_parameters` (legacy route). Regression test: `tests/integration/test_parameter_safety_net.py` (43 cases — predicate units, payload-shape validators, REST integration, engine-state-not-corrupted contract). Routes annotated in `docs/modules/pianoid-middleware/REST_API.md` "Engine safety net (catastrophic-input rejection)". CODE_QUALITY.md S5b updated to mark closure. **Range bounds beyond catastrophic predicates were intentionally NOT added** — the user's dev-2706 directive was to remove UX clamps; this safety net is hard-correctness, not UX defense.
- ~~**MIDI notes sound twice — `/play` cross-transport dedup gap**~~ — **FIXED 2026-05-03 (dev-md01).** The user-reported regression "MIDI notes sound twice" + "the was a filter against it" traced back to a split-state dedup. The original module-global filter (`eabf0b6`, 2025-05-20) caught every duplicate when REST `/play` was the only ingress. Commit `c49a0dd` (2026-04-11) added Flask-SocketIO + a parallel WS `play` handler with its own per-SID `_ws_last_command`, leaving `last_command` as REST-only. The two stores never cross-updated, so a duplicate that crossed transports (one event via WS, the duplicate via REST — common during a transient WS reconnect where `usePreset.playNote` falls back to REST) OR came from a different WS SID (e.g. multiple browser tabs) passed both filters. Confirmed by direct measurement against the running backend (`D:/tmp/midi_dedup_probe.py`): pre-fix, cross-transport WS→REST and cross-SID WS1→WS2 each produced a +1 event delta; post-fix, both produce +0. Fix: collapsed the two stores into a single shared module-global `_last_play_cmd_key` with a thread-safe helper `_is_duplicate_play(mapped_d1, command)`. All four duplicated dedup branches in `backendServer.py` (WS unified, WS legacy, REST unified, REST legacy) route through the same helper (S3 no-duplication, P1 single-source-of-truth). Disconnect cleanup is no longer needed (no per-SID slot). Regression test: `tests/system/test_play_dedup.py` (8 cases — same-transport REST + WS, cross-transport WS→REST + REST→WS, cross-SID, distinct-events sanity). Doc-gap closure: `docs/modules/pianoid-middleware/REST_API.md` `/play` section now documents the dedup contract (was undocumented pre-fix). The frontend was NOT changed — the bug was purely backend-side in how the two transport handlers shared dedup state.
- **C++ `circular_buffer_chunks` default is wrong for SDL3** (`Pianoid.cuh:51`) — struct default is `4` (the ASIO buffer size); SDL3 driver requires `>= 16` per the same comment. dev-f99c (2026-05-01) patched the symptom in the Python helper `pack_initialization_params_for_cuda` so `audio_driver_type=0` and `==3` set `circular_buffer_chunks=16` explicitly, but any future caller that constructs `InitializationParameters` directly (e.g. a new in-process test, an out-of-tree consumer of pianoidCuda) and selects SDL3 without overriding the chunks field will hit the same in-place-reload underrun. Proper fix: clamp `circular_buffer_chunks` inside `SDL3AudioDriver` constructor (or `AudioDriverFactory::createDriverWithType`) when the requested value is below the SDL3 minimum, so the C++ side enforces its own invariant. Requires CUDA work — separate /dev session.
- **`use_simulation`/`use_placeholder` placeholder is vestigial — decide rewrite vs. retire** — `pianoid_cuda_placeholder.py` was a pre-library-API stub used to develop middleware Python without a CUDA build. It has not been kept in sync since the library-API refactor: `Pianoid.__init__` signature is wrong (caller passes `(strings_in_pitches, sm=self.sm)` but stub takes `(gauss_params, strings_in_pitches, sm=False)`); methods needed by current `init_pianoid` are absent (`loadPresetToLibrary`, `switchPreset`, `setRuntimeParameters` / the `pianoidCuda.RuntimeParameters` class, `shutdownGpu`). dev-b001 (2026-05-01) closed the destructive symptom by rejecting `use_simulation=1` at the Flask layer with HTTP 400. The decision deferred is whether to **(a)** rewrite the placeholder to the library-API surface (~200 LOC + expose additional `pianoidCuda.*` classes from the placeholder side) so headless-Python middleware development is possible again, **(b)** retire the feature outright — drop `use_simulation` from `/load_preset` body, drop `use_placeholder` kwargs through the call chain, delete `pianoid_cuda_placeholder.py`, also update the WIP S3 deferred note about `/load_preset` "raises KeyError if `use_simulation` is missing — no defaults" by removing the field, or **(c)** make it a frontend-only feature (drop the kwarg flow but keep a no-op for legacy clients). Prior frontend work that referenced `use_simulation` still exists; option (b) needs a frontend grep. Tracked from dev-b001 fix 2026-05-01 — the 400 guard is surgical scope-limited; the cleanup is the principle-violation (S3 no-duplication / S5 fail-fast) that the 3-line patch smell test surfaces.
- **`Pianoid::getSoundRecords` buffer-width bug** (`Pianoid.cu:1487`) — hardcodes the host buffer width to `num_strings * NUM_PARAMS_IN_SOUND_RECORD`, but mode-indexed records (record 1 `SOUND_REC_MODE_STATE`, record 3) are written by `modeNo`. Any future preset with `num_modes > num_strings` will overflow the kernel-side write. S1 added Python-side bounds clamping in `PanoidResult.get_record`, but the underlying C++ buffer needs resizing to `max(num_strings, num_modes)`. Requires CUDA work — separate /dev session.
- **Expose `Pianoid::getModeDisplacements` to Python and the UI** — C++ method already returns `[q, q_prev, dec, omega, mass]` in a single D2H call, no debug build required. No Python wrapper or chart function consumes it today. Would replace the debug-only `record 1` path for release-safe mode inspection. Lower priority since S2 may obviate it via the unified play_mode flow.
- **0xF1 TEST_MODE_ONLY MIDI status byte** — `EventDispatcher::dispatch` (`EventDispatcher.cu:189`) handles a custom MIDI status `0xF1` for `addModeExcitation`. Not documented in REST_API.md or any event-system doc. Captured in `play_mode_chart_function` but otherwise undocumented. Address in S2's documentation pass or as a standalone doc-only fix.
- **Math/physics primer** (proposed `docs/modules/pianoid-cuda/MODE_PHYSICS.md`) — covers `frequency↔omega` and `decrement↔dec` discrete mappings, dt asymmetry between string and mode updates, `(1-dec)` damping factor, SoA layout. Currently fragmented across `SYNTHESIS_ENGINE.md` and `Mode.py`. Standalone doc-only task; can be addressed at any time.
- **`test_derivative_comparison` 2 new failures** (2026-04-28) — surfaced during the mass→mass_inv rename and chartFunctions/chart_config refactor in this session. Suspected real regression introduced by C-1 demote, chart_config edits, or the rename. Investigate which commit broke the assertions; either fix the test expectations or revert the underlying behaviour change.
- **npm `@latest` MCP server fragility** — `~/.claude.json` mcpServers entries use `npx -y X@latest` for chrome-devtools, context7, and google-drive. Long-running orchestrator sessions can lose stdio pipes to these servers; they don't auto-reconnect, so the only recovery is a VS Code reload. Mitigation: pin versions (e.g. `@1.4.7`) instead of `@latest` in `~/.claude.json` so a transient `npx` re-resolve can't pull a different binary mid-session.
- **Apply Frontend State Discipline (3 principles) to remaining matrix editors** — Phase B5 audit (dev-833f, 2026-04-30) identified the same H3 anti-pattern (speculative-emit useEffects + non-presetVersion-driven re-init) in PianoidTuner.js for these editors: deck Feedin (`PianoidTuner.js:987-996`), deck Feedback (lines 1014-1023), Strings (lines 1029-1109), Modes (lines 1129-1198), Excitation (lines 1208-1318, partially mitigated via `skipExcitationSyncRef`). Phase C2 refactored only the SC editor as the reference implementation (~230 LOC). Refactoring all five remaining editors is ~600 LOC delta in PianoidTuner.js plus per-editor regression tests (~400 LOC), with integration-regression risk in selection/highlighting/workbench coordination. User has not yet reported H3 symptoms in those editors but the principles apply project-wide. Tracked from dev-833f Phase B5 audit 2026-04-30. See `docs/architecture/SYSTEM_OVERVIEW.md` "Frontend ↔ Backend State Discipline" and `docs/modules/pianoid-tunner/OVERVIEW.md` for the SC editor pattern to follow.
- ~~**Cross-mode-count `/preset/switch` crashes engine**~~ — **FIXED 2026-05-01 (dev-c529).** Root cause was the Python-side `switch_preset` in `pianoid.py`: it swapped `self.sm` and `self.modes` from `_library_models[name]` but dropped `self.mp`, leaving `mp.num_modes` permanently stuck at whichever preset was loaded FIRST. Two failure modes via `parse_range`/`pack_for_interface`: (a) Belarus(196) → Baseline(100) over-indexed the smaller deck arrays, raising `IndexError` and HTTP 416; (b) Baseline(100) → Belarus(196) silently truncated to 100 of 196 mode coefficients per pitch. Two-line fix: also assign `self.mp = model['mp']` and propagate to `param_manager.mp`. Regression test: `tests/system/test_preset_switch_mode_count.py` (3 cases — both directions + param_manager mp sync). Originally tracked from dev-833f Phase D3 R7 (2026-04-30).
- ~~**Listen-mode toggle + APPLY destroys engine on Belarus**~~ — **FIXED 2026-05-01 (dev-b001) — corrected diagnosis.** The "listen-mode toggle" framing was a misleading correlation. dev-eng-bug-1-r's Phase A counter-finding (2026-05-01) established via measurement that the real destructive parameter was `use_simulation=1` (which the UI auto-flipped during APPLY in some sequences) and the bug reproduced **on all presets** (Baseline + Belarus + others), with any listen_mode setting. dev-b001 confirmed: pre-fix, POST `/load_preset` with `use_simulation=1` returned HTTP 500 `TypeError: Pianoid.__init__() missing 1 required positional argument: 'strings_in_pitches'` AND destroyed the live engine (`destroyPianoid()` ran on line 666 BEFORE the failing init). Root cause: `pianoid_cuda_placeholder.Pianoid.__init__(self, gauss_params, strings_in_pitches, sm=False)` has been left to bit-rot — three params with `gauss_params` first, but the caller in `pianoid.py:1775-1778` only passes `(strings_in_pitches, sm=self.sm)`. Even if the constructor signature were repaired, the placeholder is missing the entire library-API surface (`loadPresetToLibrary`, `switchPreset`, `setRuntimeParameters` / `RuntimeParameters` class, `shutdownGpu`) that `init_pianoid` calls immediately after. Fix: reject `use_simulation=1` with HTTP 400 `FeatureNotSupported` BEFORE destroying the engine — surgical scope-limited 17 LOC guard at the top of `backendServer.py:load_preset_route`. Regression test: `tests/system/test_use_simulation_rejected.py` (5 cases — HTTP 400 + error code + message content + engine-not-destroyed contract via patched global + control: `use_simulation=0` and missing field both pass the guard). REST_API.md updated with `use_simulation` field semantics and the 400 response body. The placeholder cleanup itself (rewrite or retire) is filed below.
- ~~**In-place `/load_preset` with audio_driver_type=0 crashes engine**~~ — **FIXED 2026-05-01 (dev-f99c).** Root cause was in `pack_initialization_params_for_cuda` (`pianoid.py:2001-2003`): the type=0 path set `init_params.audio_driver_type = -1` (compile-time default sentinel) but left `circular_buffer_chunks` at the struct default of `4` (ASIO buffer size). On Windows builds compiled with both `USE_ASIO_AUDIO` and `USE_SDL3_AUDIO`, the C++ side resolved `-1` to the compile-time default driver — but with the buffer depth left at the ASIO default, the SDL3 driver re-construction on the SECOND in-place `/load_preset` reload (with the audio thread already running) failed during reinit. The exception was caught by `run_online`'s try/except so the process didn't die hard; instead the engine entered `audio_driver_active=false, exception=true` (visible in /health). First-time loads worked because the smaller buffer was still drained successfully on a fresh init. Fix: pin type=0 explicitly to `pianoidCuda.AudioDriverType.SDL3` AND set `circular_buffer_chunks=16` (matching what type=3 does). 8-line code change. Regression test: `tests/system/test_load_preset_audio_driver_type_0.py` (3 cases — pin-to-SDL3, type-0 == type-3 contract, clean engine state with audio_off). Note: the original WIP description's claim that /health returns `pianoid_loaded:false, gpu_initialized:false` was inaccurate — actual symptom is `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:false, exception:true`. The "default driver = no driver" framing in `tests/system/conftest.py` was also misleading: the in-process fixture works because it never calls `startApplication` (driver constructed but never `init()`'d), not because the type=0 path was hardware-free. Originally tracked from dev-833f Phase D3 audio_off-strict re-verification (2026-04-30).
- ~~**`/load_preset` with audio_driver_type=3 (SDL3) fails: "missing strings_in_pitches"**~~ — **RESOLVED with the audio_driver_type=0 fix above (dev-f99c, 2026-05-01).** Independent investigation 2026-05-01 (orchestrator-spawned read-only agent) could NOT reproduce on a clean backend with audio_driver_type=3 — fresh /load_preset with type=3 returns 200 OK every time. Root cause: there is only ONE `pianoidCuda.Pianoid()` constructor call in middleware (`pianoid.py:1813-1816`), identical for all driver types — no driver-type branching around the constructor. dev-de72's original observation occurred after killing stale processes + restarting backendServer — likely state-corrupted reload from a prior failed init produced by the type=0 underrun bug above. Post-fix verification by dev-f99c: type=3 load returns 200 OK with `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:true, exception:false`. Related independent finding: `tests/unit/test_mic_analyzer.py:74,265` has a wrong comment claiming driver_type=3 is "ASIO" (it's SDL3 in Python middleware mapping; ASIO_CALLBACK in C++ enum) — doc-only fix, separate small follow-up.

---

## Audio Testing Modes Enforcement (2026-04-29)

**Status:** C-1 / C-2 / C-3 / C-4 committed. C-6 / C-7 partial: TESTING.md, CLAUDE.md, and 5 skill MDs (test-ui, pianoid-ui, diagnose, dev, fn) updated to enforce strict-A1 audio_on / audio_off binary contract. The full plan is summarised in [TESTING.md](TESTING.md). The /play_keyboard contract change (original C-5) is deferred — see deferred items below.

| Phase | Scope | Commit |
|---|---|---|
| C-1 | DEMOTE — driver-off conversions, register markers | `415d130` (PianoidCore) |
| C-2 | test_performance SPLIT into _audio_off + _audio_on | `acc717b` (PianoidCore) |
| C-3 | PROMOTE — test_playback / test_asio_multichannel / cycle_profile mic+compare | `a95500a` (PianoidCore) |
| C-4 | Frontend indicator split — Synth + Audio Chips | `aedb6ff` (PianoidCore) + `f287e57` (PianoidTunner) |
| C-5 | /play_keyboard contract clarification + deprecation warn | **Deferred** — see below |
| C-6 / C-7 | TESTING.md, CLAUDE.md, 5 skill MDs | This commit |

### Deferred items

- **TestSynthReachesMic verification** — needs speaker→mic loopback configured on the dev box. Currently skipped via `@pytest.mark.skip(reason="deferred: speaker→mic loopback verification pending")`. Flip `_MIC_LOOPBACK_CONFIGURED=True` in `tests/system/conftest.py` once the loopback is set up; the entire audio_on suite re-enables in lockstep.
- **`cycle_profile.py --audio-mode=audio_off` variant** — currently exits 1 with a WIP-pointer message ("audio_off variant not yet implemented; use tests/system/test_performance_audio_off.py for offline timing"). Implementing requires a kernel-only timing path in cycle_profile that doesn't engage the driver.
- **`test_asio_multichannel` tight per-channel transferRatio calibration** — current implementation uses lenient `transfer_threshold=1e-3` per channel. Tight calibration needs a known-good mic-position calibration asset.
- **`/play_keyboard` mode=online,capture_mic=false strict-A1 ambiguity** — the path engages the driver without a mic. Original C-5 plan was to deprecate this combination with a warning, then remove in follow-up. Deferred per user direction.
- **F5 callback-stats reproduction** — `probe_f5_silent_engine.py` was demoted to audio_off, so its callback-stats output is no longer meaningful. If a future stream investigation reopens, the probe needs to be promoted to audio_on (with mic loopback) or replaced.
- **Calibration REST endpoint test coverage** — `/calibrate_volume`, `/measure_rms`, `/equalize_keyboard`, `/tune_note` are the canonical audio_on REST surfaces but have no automated test coverage today. Future audio_on test development should target these.
- **`pianoid.py:54` debug-variant module-load-order trap** — `select_cuda_variant(use_debug=True)` checks `if "pianoidCuda" in sys.modules`, but `pianoid.py` imports pianoidCuda at module top, so by the time `from pianoid import initialize` returns, the release binary is already loaded and the warning "pianoidCuda already imported -- cannot switch to debug variant" fires. Affects ALL standalone scripts that request `use_debug_build=True` (cycle_baseline.json sets this true). Standalone scripts silently run against the release binary instead. Requires reordering pianoid.py imports — separate /dev session.
- **`cycle_profile.py --matrix` single-process iter hot-swap** — currently fixed via subprocess fan-out (each combo runs as its own process, single Pianoid each). A future single-process implementation would require a runtime setter for `string_iteration` (currently constructor-only); that requires C++ work and a separate /dev session.
- **`pianoid.py:1317` `start_realtime_playback_unified()` hardcodes `config.audio_enabled = True`** — discovered during C-4 verification. Loading a preset with `audio_on: 0` still results in `audio_driver_active: true` because this call path overrides the Python-side `pianoid.audioOn` flag. The new tests sidestep this by passing `audio_on=False, audio_driver_type=0` at construction time, but the runtime preset switch path still has this bug. Needs a /dev session to fix.

---

## System-Wide Code Review Cleanup (2026-04-27)

**Status:** In progress — Phase 1.1 done and pushed. Phases 1.2–4 pending.

A `/review system` audit produced a categorized punch list (1 Critical / 9 High / 9 Medium / 8 Low). Full report:

- [reviews/system-review-2026-04-27.md](reviews/system-review-2026-04-27.md)

User-stated focus: structural consistency, API consistency, redundancy, dead code.

### Repo state at handoff (system restart)

All four repos are committed, pushed, and in sync with origin:

| Repo | Branch | HEAD | Notes |
|---|---|---|---|
| PianoidCore | dev | `261e865` | Merge feature/fix-volume-sensitivity-backend-init |
| PianoidBasic | dev | unchanged | (no edits this session) |
| PianoidTunner | dev | `7dd3e38` | Phase 1.1 ghost-UI removal pushed |
| PianoidInstall | master | `6b07897` | Phase 2 wrap-up archive + WIP cleanup |

WIP "Active Dev Sessions" table is empty. No outstanding locks. No unpushed commits.

### Prioritized cleanup plan

**Phase 1 — Pure deletions (low risk, high signal)**

| ID | Item | Status |
|---|---|---|
| 1.1 | Delete ghost `App.js` + dead-code closure (PianoidTunner) | **Done** — 15 files / 2677 LOC removed; 2 YELLOW C4 entries eliminated (Deck.jsx 772, Excitation.jsx 545); commit `7dd3e38`; log archived at `logs/archive/dev-ghost-ui-b8bb-2026-04-27-062035.md` |
| 1.2 | Delete `MeasureGenerator.py` (291 LOC, fully unreferenced) and inner `MeasureGenerator` class in `stringMapGenerator.py:326` | Pending |
| 1.3 | Delete checked-in `PianoidBasic/build/lib/` stale tree (20 .py files); add to `.gitignore` | Pending |
| 1.4 | Audit `TODO "TEMPORARY!!!"` rot in `pianoid.py:136, 198` — confirm no longer needed and remove | Pending |

**Phase 2 — API / structural straightening (no behavior change intended)**

| ID | Item | Notes |
|---|---|---|
| 2.1 | Rename one of the two `MeasurementEngine` classes — `auto_tuner.py:49` (offline render) → `OfflineRenderEngine`; the mic-based one in `measurement_engine.py:46` keeps the canonical name | API consistency |
| 2.2 | Resolve `/modal/apply_to_preset` signature drift between `backendServer.py:2927` (port 5000, body `{project_name, selected_chains}`) and `routes.py:853` (port 5001, body `{selected_modes}`); two parallel `ModalAdapter` instances with disk-rehydration on each call from main server | API consistency, P1 authority |
| 2.3 | Replace 4 hardcoded `http://127.0.0.1:5000/...` URLs in `components/Excitation.jsx` with the existing API base helper | API consistency |
| 2.4 | Drop `dump_coeff_tail` synonym in `parameter_manager.py:79` (N2 violation, same family as the documented `dump_ratio` bug) | Naming consistency |
| 2.5 | Decide endpoint naming convention (`/preset/list` slash-segmented vs `/load_preset` underscore-flat) and migrate stragglers | API consistency |

**Phase 3 — Layer / concern cleanup**

| ID | Item | Notes |
|---|---|---|
| 3.1 | Move PianoidBasic plotting deps (matplotlib/seaborn/librosa) out of the domain model — `chart_animation.py`, `sound_measurements.py` pull plotting deps into 6 model files (C1 layer violation) | Move to a separate dev/tools package |
| 3.2 | Pull engine lifecycle calls (`_stop_online_engine`, `_restart_online_engine`) out of `chartFunctions.py` (chart concern bleed, P2) | |
| 3.3 | Cut `chartFunctions.py:4` import from `FirFilterTest.py` (production server depending on a test file) | |

**Phase 4 — God-object splits (each its own `/dev` session, sequential, not parallel)**

| ID | File | LOC | Plan |
|---|---|---|---|
| 4.1 | `PianoidCore/pianoid_middleware/backendServer.py` | 2990 (RED, +159 vs baseline) | Split by route group |
| 4.2 | `PianoidCore/cuda_src/Pianoid.cu` | 2983 (RED, +31) | Split by phase (excitation, propagation, mode, mixing) |
| 4.3 | `PianoidCore/pianoid_middleware/pianoid.py` | 2547 (RED, +59) | Carve runtime-params + preset-IO sub-modules |
| 4.4 | `PianoidCore/pianoid_middleware/chartFunctions.py` | 2612 (RED, +23) | Split chart-render vs chart-data-fetch |
| 4.5 | `ModalAdapter` class in `pianoid_middleware/modal_adapter.py` | 2628-line class | Split by pipeline stage |
| 4.6 | `PianoidTunner/src/hooks/usePreset.js` (1516, +79) and `src/components/NumInput/NumInput.js` (1565, +89) | RED | Split by responsibility |

Pending: dispatch order TBD by user. Phase 4 is heavy and must be triaged one file at a time.

### Open question parked at restart

Awaiting user direction: chain Phase 1.2 + 1.3 + 1.4 (all small, low-risk deletions) into one `/dev` session, or hold and dispatch each individually. Last Telegram message: msg id 1317.

---

## Cycle Profiling Harness

**Location:** `PianoidCore/tests/system/cycle_profile.py`
**Config:** `PianoidCore/tests/system/configs/cycle_baseline.json`

Measures per-stage cycle timing under configurable iter / mode (idle vs playing) / preset / driver. Captures Stage A (synthesis kernel + device sync), Stage B (regime output: D2H + driver push), and full cycle via `initTimeRecord`/`getTimeRecord` + `getCallbackStats`. Output: JSON with median / p95 / p99 / max per stage plus underrun rate.

Invoke:

    cd PianoidCore
    .venv/Scripts/python tests/system/cycle_profile.py \
        --config tests/system/configs/cycle_baseline.json \
        --output /tmp/cycle.json

Flags: `--iter`, `--mode {idle|playing}`, `--preset`, `--driver`, `--buffer`, `--duration` (override config); `--matrix` (run 2×2 iter×mode); `--downsample-6to5` (opt-in adapter for pre-fac66cb binaries with NUM_BASE_LEVELS=5).

**Findings (2026-04-22):**
- IversPond_128modes iter=8 idle SDL3: Stage A median ~780 μs across ee068dd (Mar 31) through HEAD — no kernel regression post-Volume-Calibration.
- 2×2 matrix reveals mode-count-dependent active-cycle cost: Belarus_196modes shows +444 μs per active cycle vs idle; IversPond_128modes does not.

**Note (2026-04-24):** The 780 μs / +444 μs figures above were captured against PianoidCore post-`5137240` binary AND PianoidBasic post-`83ac75d` `Mode.py`. The `83ac75d` commit (`PianoidBasic/Pianoid/Mode.py` 3-tuple `pack_modes`) was missing from `origin/dev` until 2026-04-24 — clean rebuilds during that window failed with `mode_state.size() = 1120 > 768` because pre-`83ac75d` `Mode.py` emitted 5-tuple SoA. If you cannot reproduce these timing numbers, verify `git -C PianoidBasic cat-file -t 83ac75d` succeeds locally (and that `Pianoid 0.1.13` is reinstalled into `PianoidCore/.venv/` after pulling).

### Test Environment

Cycle profiling timings are sensitive to hardware (GPU model/clock, CPU IPC, memory speed) and software stack state (CUDA toolkit, driver, MSVC, OS build). Every future profiling run **must** record the host environment so cross-machine comparisons are meaningful.

**Required fields for every profiling report:**

| Field | Capture command (Windows) |
|---|---|
| CPU model, cores, threads, base clock | `Get-CimInstance Win32_Processor \| Select Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed` |
| RAM total + speed | `Get-CimInstance Win32_PhysicalMemory \| Select Manufacturer, Capacity, Speed, PartNumber` |
| GPU model, VRAM, driver, compute cap | `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv` |
| NVIDIA driver / CUDA runtime | `nvidia-smi` (header line: `Driver Version: X.Y` / `CUDA Version: A.B`) |
| CUDA toolkit (build-time) | `nvcc --version` |
| OS + build | `Get-CimInstance Win32_OperatingSystem \| Select Caption, Version, BuildNumber` |
| MSVC version | `ls "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/"` |
| Python version | `<venv>/Scripts/python --version` |
| Disk where venv lives | `Get-Partition -DriveLetter X \| Get-Disk \| Select FriendlyName, BusType, MediaType` |
| Date of measurement | ISO 8601 date |

**Baseline entries:**

| Field | 2026-04-25 baseline (this host) | Apr 22 reference system |
|---|---|---|
| CPU | Intel Core i7-9700F @ 3.0 GHz, 8 cores / 8 threads (no SMT) | not recorded |
| RAM | 32 GB DDR4-2400 (2 × 16 GB Kingston KF3600C16D4/16GX, running 2400 MT/s) | not recorded |
| GPU | NVIDIA GeForce RTX 4070 SUPER, 12 GB GDDR6X | not recorded |
| GPU compute capability | 8.9 (Ada Lovelace) | inferred ∈ {8.0, 8.6, 8.9} (per `build_config.json` `cuda_arch_list`) |
| NVIDIA driver | 560.94 | not recorded |
| CUDA runtime (driver-side) | 12.6 | not recorded |
| CUDA toolkit (build-side) | 12.6.20 (`nvcc` built 2024-06-14) | likely 12.x (`build_config.json` structure) |
| OS | Microsoft Windows 10 Pro 64-bit, build 19045 | Windows (inferred from log usage of `taskkill`, `cmd //c`, `.bat`) |
| MSVC | VS2022 BuildTools, VC Tools 14.44.35207 | not recorded |
| Python | 3.12.0 | 3.12 (inferred from venv layout) |
| Venv disk | tigo SSD 120G (SATA SSD) | not recorded |
| Other disks | Crucial CT240BX500SSD1 (SATA), FIKWOT FN501 Pro 256GB (NVMe) | n/a |
| Measurement date | 2026-04-25 | 2026-04-22 |

**Note:** The Apr 22 reference system's hardware specs are not recorded in any archived agent log (searched `dev-ab-d2h`, `dev-volume-iter-fix`, `dev-perftest`, `dev-f5-stream`, `dev-paramsync`). Future profiling sessions should capture the full required-fields table before reporting timing data, so that absolute numbers (not just relative deltas) become comparable across machines. Without hardware data, a 30–35 % Stage A median delta between two systems cannot be classified as code regression vs hardware difference.

Consolidates prior ad-hoc probes formerly kept under `D:/tmp/test_cycle_*`.

---

## Known Follow-Ups

- **`play_note_offline_chart_function` — missing `get_string_indices`.** The chart function calls `pianoid.get_string_indices(pitch)` (chartFunctions.py ~line 1529), which does not exist on `Pianoid`. The surrounding try/except swallows the `AttributeError` and leaves `string_oscillation_data = (0, 0)`. Effect: String Osc Max/RMS always display 0 in the note_playback chart. Found during dev-63c2 fix; left out of scope by orchestrator. Likely replacement: `pianoid.sm.get_string_indices(pitch)` or a similar StringMap API — needs a brief code audit before fix.

- **Secondary iter-dependence in spectrum/HF/decay** (2026-04-23, post-volume-iter fix). Peak magnitude is iter-invariant after `dev-volume-iter-fix` (coeff_force dt² fix + preset rescale). However HF content increases ~25dB from iter=4 to iter=12, spectral centroid doubles (1340 → 2687 Hz), init/sust decay rates vary. Likely root cause: `coeff_frequency_decay` (Kernels.cu:139) needs iter compensation. Out of scope for the volume-bug fix. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Secondary issue".

- **pip install returns stale pianoidCuda.pyd** (2026-04-23 discovery). `pip install --force-reinstall --no-cache-dir pianoid_cuda/` silently produces cached pyd despite fresh .obj compilation. Workaround: always use `./build_pianoid_cuda.bat --heavy --release` (does full clean + pip cache purge). Structural fix would identify the caching layer in setup.py / pip build isolation. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Build pipeline discovery".

### Calibration bisection-path audit (deferred)

The factor-space clamp fix (dev-cal-clamp-fix, 2026-04-26) addresses the direct-correction paths in `synthesis_tuner.py` (`_synthesis_correct_once`) and `acoustic_tuner.py` (`acoustic_tune`). The bisection paths in `calibration_controller.py` (`_direct_correct_to_target` at ~line 1060, plus probe-update sites at ~723, ~1160, ~1186) ALSO clamp probe values in absolute-mean space [0.001, 50]. Likely break for any preset with realistic large coefficients. Audit and fix in a future task.

### Calibration REST observability gaps (deferred)

End-to-end verification of calibration writes via REST is blocked by two pre-existing bugs (discovered during dev-cal-clamp-fix verification, 2026-04-26):

- `/get_parameter/gauss_full/{pitch}` reads from cached `excitation.curves` GaussCurve objects via `to_dict()`; `_apply_single_correction` and `_set_amplitude_scale` mutate `levels_matrix` directly. UI reads stale values post-calibration.
- `/pause_synthesis` transitions state machine to PAUSED but C++ main loop continues spinning. `/synthesis_measure` then fails with "Cannot render offline: Main loop is active".

Either bug should be addressed before live UI verification of calibration is reliable.

---

## WebSocket Migration — Hybrid REST + Socket.IO

**Status:** Complete. Merged and pushed (2026-04-11). All 4 phases shipped.

Flask-SocketIO backend + socket.io-client frontend. Note playback via WebSocket with REST fallback, lifecycle push events (replace health polling), calibration progress push, MIDI playback push, engine error push, **parameter updates via WebSocket** (all 8 debounced write paths: string, mode, excitation, feedin, feedback, sound channel, volume, deck feedback). Debounce reduced from 300ms to 50ms when WS connected. `param_ack` events returned to client. Independent fixes: print() gated behind PIANOID_DEBUG_PLAY env var, deduplication added to unified play path, `_map_feedback_to_coefficient()` helper extracted.

Tests: 30/30 pass (20 unit in `test_websocket.py`, 10 integration in `test_websocket_integration.py`).

See [WEBSOCKET_MIGRATION_ANALYSIS.md](WEBSOCKET_MIGRATION_ANALYSIS.md) for full analysis and implementation details.

---

## Preset System Revision — Per-Preset Runtime State & Complete Switch

**Status:** Planned. Implementation pending.

Volume and feedback are global runtime parameters that persist across preset switches — switching from a loud preset A to quiet B and back loses A's volume/feedback settings. Additionally, available notes are not refreshed after switch (stale keyboard), the frontend MIDI feedback slider position is lost (lossy reverse mapping from coefficient), and rapid `[`/`]` key presses can interleave switch requests.

The fix adds a `runtime` dict to each `_library_models[name]` entry (backend-authoritative), saves/restores `RuntimeParameters` during `switch_preset()`, enriches the `/preset/switch` response with volume/feedback/sensitivity values, and updates the frontend to consume these values and refresh available notes.

**Sound-channel cache silence on preset switch — resolved (2026-04-20, Wave B).** Independent of the planned runtime-state work, preset transitions could silence Strings mode because in-flight debounced `changeSoundChannelValues` / `changeSoundChannelFeedback` writes from the outgoing preset resolved after the refetch and merged stale pitch keys back via `setSoundChannelData(prev => ...)`. Fixed by clearing `soundChannelData` + `soundChannelFeedbackMatrix` to `null` at the top of `loadPreset()` and `switchPreset()` in `usePreset.js`, before the async refetch.

**Sound Channels strings-axis tooltip null + bulk-edit no-op — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing bug surfaced after Wave D manual testing. In strings axis, the matrix from `/get_parameter/feedback/output` uses backend output-pitch keys (`"128".."128+N-1"`) while `availableOutputChanels` exposes the shifted `[0..N-1]`. All downstream consumers (canvas hover lookup, `useMatrixHistory.calcChange`, Workbench) indexed by the shifted frontend channel, producing undefined lookups → tooltip rendered `Value: null`, and the pitch-key guard in `calcChange` silently no-op'd Cell/modesVector/modesVectorDrawn edits. Row and column bulk edits in strings axis never reached the backend. Fixed in `useSoundChannels.js` by normalizing strings-axis keys on init (strip 128) and denormalizing on emit (restore 128), so the canvas/history/workbench stay axis-agnostic while the network payload preserves the backend convention. Verified end-to-end: tooltip now shows real values, row/col bulk edit mutates the matrix, modes axis unchanged.

**useMatrixHistory undo crash on rapid edits — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing P1-violation latent since the hook was written. `recordChange` used a stale closure for `currentStep` when slicing the history array — in a burst of clicks within one React batch, every call saw the same captured `currentStep`, so `setHistory(prev => [...prev.slice(0, currentStep), change])` produced only one entry (last-write-wins), while `setCurrentStep(prev => prev + 1)` correctly advanced per-call via its functional updater. `currentStep > history.length` left holes; `restoreMatrixAtStep(step-1)` walked past the end → `entry.operation` on undefined → crash. Surfaced only after the strings-axis fix enabled edits that previously no-op'd silently. Fixed by adding `stepRef = useRef(0)` as the synchronous slice-boundary source of truth — read and bumped inside `recordChange` before the setState calls, so per-call boundaries are correct even without rerender. `init`, `restoreMatrixAtStep`, `undo`, `redo` all synchronized via the ref. Defensive clamp in `restoreMatrixAtStep` (`Math.min(step, history.length)` + skip undefined entries) so a future desync cannot crash. Verified: 5-click burst now produces step=len=6 (was step=6/len=2 before), undo/redo cycle through all steps without error, truncation-after-undo works. Applies to all matrix-history consumers (strings/modes SC, feedin, feedback, strings params, modes params, excitation).

See [PRESET_SYSTEM_REVISION_PLAN.md](PRESET_SYSTEM_REVISION_PLAN.md) for full analysis, architecture decision, implementation steps, data flow, edge cases, and verification checklist.

**Files to modify:**
- `PianoidCore/pianoid_middleware/pianoid.py` — `switch_preset()`, `load_preset_to_library()`, `init_pianoid()`, new helpers
- `PianoidCore/pianoid_middleware/backendServer.py` — `/preset/switch` response, `/set_runtime_parameters` sync
- `PianoidTunner/src/hooks/usePreset.js` — `switchPreset()` consume runtime state, add `getAvailableNotes()`, concurrency guard

---

## NumInput Bidirectional Data Flow — Cursor Drift on Rapid Stepping

**Status:** Partially fixed. Core bidirectional issues resolved; cursor drift during rapid arrow/wheel remains.

Seven issues were fixed in `NumInput.js`, `PropertyInput.jsx`, and `usePreset.js` to stabilize the digital input components when connected to the live backend. The remaining open issue is cursor position drift during rapid arrow key or scroll wheel stepping — caused by React's controlled input pattern resetting the cursor on each render cycle.

See [DIGITAL_INPUT_ANALYSIS.md](DIGITAL_INPUT_ANALYSIS.md) for full root cause analysis, fixes applied, and potential solutions for the cursor drift.

**Branch:** `feature/fix-bidirectional-input` in PianoidTunner

---

## C++ Logging Migration

**Status:** Session 1 complete. Remaining files pending.

Replaced all `printf`/`cout`/`cerr` in hot-path and core C++ files with `PianoidLogger` file-based logging. Three hot-path statements fixed (cycle-level `std::cout` in `Pianoid.cu`, per-callback `printf` in `SDL3AudioDriver.cpp`, warmup `cout` in `CycleTimeEstimator.cu`).

See [LOGGING.md](../modules/pianoid-cuda/LOGGING.md) for full details and migration status.

| Scope | Status |
|-------|--------|
| PianoidLogger infrastructure | Done |
| Hot-path fixes (3 locations) | Done |
| Core C++ files (~175 statements in 8 files) | Done |
| pybind11 bindings + Python lifecycle | Done |
| Remaining C++ files (~75 statements) | Pending |
| Python print migration (578 statements) | Planned |
| `backendServer.py:475` hot-path `print` → `logger.debug` | Done (dev-bprint, 2026-04-20) |
| `backendServer.py` other request-handler prints (~80 calls across `/set_parameter`, volume, feedback, play, MIDI) | Pending — latent: same break mode if stdout pipe fails, now shielded by global errorhandler (returns JSON 500 with CORS) but still produce empty responses; best migrated to `logger` in the planned sweep |

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** F5 landed (2026-04-22, dev-f5-stream) but measured **no effect** on underrun rate. Investigation continues — compute-bound, not serialization-bound.

Two concerns were identified pre-F5:

1. **Lock-scope window (pre-existing, latent).** `produce()` releases its mutex before the D→H copy, creating a ~0.5–1.3 ms window where `consume()` can see a stale `write_position`. Not addressed by F5.

2. **Default-stream serialization (F5 hypothesis, refuted by data).** `produce()` used default-stream `cudaMemcpy` + `cudaDeviceSynchronize`. Hypothesis: this implicitly serialised the D→H copy against the synthesis kernel (also on default stream), doubling pipeline depth and turning jitter into underruns. F5 moved produce() to a dedicated `cudaStream_t produce_stream` with `cudaMemcpyAsync` + `cudaStreamSynchronize`. **The A/B data below show this had no observable effect.**

**F5 A/B measurement** (silent-engine probe, SDL3, Preset_test5, `buffer_size=4`, 30 s). Same-harness: revert F5 → rebuild → measure → restore F5 → rebuild → measure.

| Config | Pre-F5 | Post-F5 | Δ |
|--------|--------|---------|---|
| `string_iteration=8` | 33.3% underrun, 13 975 µs max | 33.4–35.0% underrun, 16 311–18 123 µs max | within noise |
| `string_iteration=12` | 110.9% underrun, 18 501 µs max | 110.3% underrun, 21 031 µs max | within noise |

The initial report of "~100% → 33.4%" was a cross-load comparison error — the ~100% came from an analyse-distortion A1 run whose `string_iterations` kwarg (plural) silently dropped and ran at default iter=12, not iter=8. After correction, same-harness A/B shows **no F5 effect** at either load level.

F5 is **kept** on correctness grounds (producer copy should not implicitly block on unrelated default-stream GPU work), but is **not the fix** for distortion. The real lever is synthesis kernel cost (iter=12: 110% = kernel over budget; iter=8: 33% = kernel near budget, OS scheduling tips it over).

See [logs/dev-f5-stream-2026-04-22-163903.md](logs/dev-f5-stream-2026-04-22-163903.md) for the full A/B and [probe_f5_silent_engine.py](../../PianoidCore/tests/system/probe_f5_silent_engine.py) for reproduction (env vars `F5_STRING_ITER`, `F5_DURATION_S`).

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | In progress — serialization refuted, compute-bound hypothesis remains |
| F5 — dedicated CUDA stream for produce() | Merged, no underrun effect (dev-f5-stream) |
| Fix `produce()` lock scope | Pending (distinct concern; F5 null result suggests it's also not load-bearing) |
| Reduce synthesis kernel cost at high `string_iteration` | Pending — now the primary lever |
| Investigate SDL3 callback jitter (300 µs stddev, 18 ms max on 10 ms cadence) | Pending — OS-scheduling hypothesis |

See [Testing](TESTING.md) for the test inventory.

---

## Interactive Stabilization Diagram — Chain Editing & Visualization

**Status:** All phases complete (Phase 1–5) + UI refactoring (2026-04-11).

See [INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md](INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md) for full architecture decisions, 5-phase implementation plan, and risk analysis.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Zoom/pan, brush selection, chain paths, bidirectional sync, visual encoding, damping toggle | Done |
| 2 | `save_edited_chains()` + `POST /modal/chains/save` | Done |
| 3 | `useChainEditor` hook + `StabilizationToolbar` + `StabilizationDiagram` extraction + `saveEditedChains` in useModalAdapter | Done |
| 4 | Interactive chart editing (mode-dependent handlers) | Done |
| 5 | Polish: unassigned detections, keyboard shortcuts, validation, performance, feedin guard | Done |
| Refactor | ESPRIT-only view, chain toggle fix, selection highlighting, rectangle zoom, damping/amplitude viz | Done |

**Refactoring changes (2026-04-11):**
- Diagram shows ESPRIT extraction data (unassigned dots) even before tracking runs
- Chain path toggle (showPaths) fixed — no longer sticks in "on" state
- Chain selection: default no selection; selected chains have white border + blue glow + larger size; unselect clears all visual emphasis
- Rectangle zoom: brush selection in select mode zooms to area; "Reset Zoom" button restores full view
- Damping overlay removed. Replaced with: (1) heatmap mode (D/A buttons) color-codes points by damping or amplitude, (2) sub-chart below main chart (Damp/Amp/Both) showing line charts for selected chains sharing X-axis

**Sub-chart data fix (2026-04-12):**
- Amplitude/shape/MAC sub-charts showed empty when loading existing projects (chains.json lacked amplitude/shape data saved before the feature was added)
- Fix: `_enrich_chains_from_esprit()` in `modal_adapter.py` back-fills amplitude and shape from ESPRIT per_scenario_results into chain detections on load, then persists enriched chains to disk

**Reference projection sub-chart (2026-04-12):**
- New "Proj" toggle button alongside Damp/Amp/MAC/Shape
- Computes signed reference projection from complex mode shapes in frontend: mean shape as reference, Re(dot(shape, conj(ref))) per detection
- X=scenario (zoom-synced with main diagram), Y=signed scalar (+in-phase / -anti-phase)
- Zero reference line marks nodal boundary, area fill highlights positive/negative regions

**Selected chain properties display (2026-04-14):**
- When chains are selected, MUI Chips appear above the main chart showing per-chain: ID, mean frequency (Hz), mean damping ratio, scenario count
- Chips bordered by stability color (green/yellow/orange/grey) for quick identification
- Compact and non-intrusive — wraps across multiple rows when many chains selected

**Visualization enhancements (2026-04-14):**
- Bridge boundary: replaced inaccurate graphic percentage line with ECharts markLine at exact scenario index, tracks zoom/pan, "Bass | Treble" label
- Chain visibility filter: ToggleButtonGroup (Stable / +Semi / All / Unasgn) filters chains by stability class; "Unasgn" hides all chains and shows only orphan detections (larger, orange)
- Chain paths visible by default (`showPaths` initialized to `true`)
- Chain selection fix: brush tool was intercepting clicks before scatter handler; tiny brush areas now detected and converted to click-select via `findNearestChain`
- Full-bridge chains (`bridge="full"`): path lines split at `bridgeBoundary` to show natural gap between bass/treble sections
- Interactive shape sub-chart: clicking selects ALL lines crossing the click area (5% Y-range tolerance), not just the single clicked line; all corresponding points highlighted on main chart (white diamond, orange glow); non-matching shape lines dim; toggleable
- Zoom fixes: brush rectangle artifact cleared via brush tool toggle off/on; reset zoom also dispatches `dataZoom` reset to 0-100% on both axes
- Shape phase alignment: scenario shapes normalized to consistent phase before display — dot product with reference shape determines sign flip, so shapes from different scenarios are visually comparable

**Zoom system refactoring (2026-04-14):**
- Unified dual-state zoom: removed ECharts `dataZoom` (type "inside") components; all zoom now flows through single `viewBounds` React state
- Manual scroll-wheel zoom: cursor-centered, log-aware for Y axis (frequency), replaces ECharts internal scroll/pinch zoom
- Reset Zoom button visible whenever any zoom source is active (not just brush zoom)
- Centralized brush lifecycle: single effect manages brush arm/disarm via `brushGeneration` counter, replacing 3 competing paths (handleBrushSelected cleanup, useEffect on option change, handleChartReady)
- Sub-charts sync with unified zoom state via `viewBounds`
- All chart animations disabled (`animation: false`) — ECharts axis interpolation caused visible intermediate state on zoom reset

**Bug 4 — interactive shape anchor for phase + magnitude alignment (2026-04-19, dev-190d):**
- Shape sub-chart ("shape across channels" mode) displayed unphased, unscaled curves. Existing `alignShape` helper phased scenarios within a SINGLE chain against that chain's own first detection, but different chains referenced different anchors and magnitudes varied wildly — so overlaid curves had no common visual reference and were not indicative.
- First attempt (auto-minimax): picked anchor channel automatically as argmax over channels of min |value| across curves. Rejected by user on redesign — the "best" channel in a noise sense may not be the one the user wants to compare at, and aggressive normalization without consent hides the raw spatial pattern when it's the useful view.
- Final implementation (user-driven anchor):
  - New local state `shapeAnchor: null | channel_index` (null = raw unphased, integer = normalize to +1 at that channel). Default null.
  - `useEffect` resets `shapeAnchor` to null whenever Shape sub-chart is toggled off, so re-enable always starts in raw mode.
  - In the `subChartData` useMemo: scenario-level `alignShape` runs unconditionally as before (no regression of prior fix); cross-curve normalization is applied ONLY when `effectiveShapeAnchor != null` (clamped to valid channel range). For each curve, multiplier = `1 / curve[anchor]` so curve passes through +1 at the anchor. Guard: curves with `|curve[anchor]| < 1e-12` are left untouched (no division by zero).
  - UI: above the Shape sub-chart, a compact `ToggleButtonGroup` lists channel numbers (0..nCh-1) plus an "OFF" button. Clicking a channel number sets the anchor; clicking another re-anchors instantly (re-triggers the useMemo via the `shapeAnchor` dep); clicking OFF clears back to raw view. OFF is disabled when no anchor is active.
  - `makeShapeSubOption` gates the dashed vertical markLine and the `"Shape (norm @ Ch<N>)"` Y-axis label behind `anchorChannel != null` — both disappear in raw mode.
  - Click-to-highlight handler on the sub-chart is unchanged: it operates on whatever `shapeSeries` it receives, so it works in both raw and normalized modes (tolerance scales with actual Y range).
- UI verified end-to-end on Belarus8D_clean (5 response channels):
  1. Default view = raw unphased curves (Y ~ -1..1). Pass.
  2. Anchor Ch 1 / Ch 2 / Ch 3 / Ch 4 → dashed markLine appears, Y-axis label updates, curves converge at the anchor. Pass.
  3. OFF → raw view restored, markLine gone, Y-axis back to "Shape". Pass.
  4. Toggle Shape sub-chart OFF → ON → state reset to null, raw view. Pass.
  5. Single chain selected + anchor set → single curve passes through +1 at anchor. Pass.

- **Extension (same batch) — percentile-based Y clipping when anchor is active:** user reported that outlier chains (chains with near-zero at the anchor) stretched the Y range to ±thousands, jamming the readable curve body near 0.
  - Added Y clip inside `makeShapeSubOption`: collect all y-values from `shapeSeries`, sort, take 5th/95th percentile, pad by 10% of the clipped range, then round to nice tick boundaries (`niceRound` helper — 0.5*10^mag steps). Always keep +1 inside the visible range so the anchor markLine remains meaningful.
  - Min-samples guard: `< 20` total values → fall back to auto-range (small sample percentile is unreliable).
  - Explicit `min: null, max: null` when anchor is off — ECharts merges yAxis options rather than replacing them, so without explicit nulls the previous clip bounds would persist after clearing the anchor (caught during UI test).
  - Raw mode (anchor null) keeps ECharts auto-range. Tooltips still show real numeric values (ECharts axis-trigger uses series data, not clipped pixels).
  - Verified visually on Belarus8D_clean (5 chains, Ch 0 anchor): before fix Y range was roughly -12000..3000 (curves invisible); after fix Y range is -4..4 (curves clearly readable, outliers run off-chart). Same Ch 0 anchor on single chain gives Y range -3..1.5. All other channels (Ch 1/2/3/4) behave similarly — readable curve body, outlier curves clip off.
  - Console: 0 new errors. Pre-existing ModalAdapter "Invalid prop children" warning and WebSocket reconnect errors on :5000 are unrelated.

**Bug 2 — brush rectangle persistence fix (2026-04-19, dev-9d5c):**
- Blue brush rectangle sometimes persisted on screen after zoom. Root cause: the clear-brush dispatch in `handleBrushSelected` lived inside the outer try and AFTER the data-path `return` statements, so any early return (unrecognized coordRange shape, pixel-conversion failure) or exception in processing (chainEditor race, NaN in geometric mean) swallowed the clear and left the rectangle visible.
- Fix (first pass): wrapped `handleBrushSelected` body in try/finally so `dispatchAction({type:"brush", areas:[]})` + `setBrushGeneration++` run on every exit path. Also added defensive `dispatchAction({type:"brush", areas:[]})` at the top of the centralized brush lifecycle effect.
- Regression (same day): first-pass fix caused a 300ms-period infinite feedback loop. `dispatchAction({type:"brush", areas:[]})` triggers the ECharts `brushVisual` pipeline which queues a throttled `brushselected` event via `visualEncoding.js:189`. The finally block's clear dispatch AND the lifecycle effect's defensive clear both produced echoes; the echo entered `handleBrushSelected` with empty areas; the inner empty-areas `return` was inside the try so the finally ran anyway, bumping generation and re-dispatching — continuous redraw of the chart region. Measured before fix: 7 brushselected fires in 2s idle.
- Fix (second pass, Option C — echo guard + single-owner clear):
  1. Added an echo guard at the very top of `handleBrushSelected`: if `params.batch[0].areas` is empty, return BEFORE the try/finally. Real user brush events always carry non-empty areas; empty-areas events are ECharts echoes or legitimate no-op clears with nothing to act on.
  2. Removed the defensive `dispatchAction({type:"brush", areas:[]})` from the lifecycle effect. The finally block in `handleBrushSelected` is the single owner of the brush clear — removing the second path eliminates a second feedback source.
- Second regression (same day, worse than first pass): user reported "rectangle persists more than before." DOM-level instrumentation (60 Hz sampler on zrender display list + `BrushController._covers / _creatingCover / _dragging`) with a real mouse-drag repro revealed a new failure mode: during a drag with a mid-drag pause (>300ms), `brushselected` fires DURING the drag. Our handler runs, dispatches `brush areas:[]`. ECharts `BrushController.updateCovers([])` at BrushController.js:189-225 empties `_covers` immediately (line 198: `this._covers = []`), but the DataDiffer `remove(oldIndex)` callback guards at line 221: `if (oldCovers[oldIndex] !== creatingCover) group.remove(...)`. When `_creatingCover` is still set (drag ongoing), `group.remove` is SKIPPED — the zrender cover element is ORPHANED (not in `_covers`, but still in `group.children()`, still rendered). After mouseup, no subsequent dispatch reaches `group.remove` for the orphan: `handleDragEnd`'s internal `brush` dispatch has `$from: modelId` which is rejected by `BrushView._updateController`'s anti-echo guard, and our echo-guard brushselected returns without dispatching. Orphan persists indefinitely.
- Fix (third pass, Option D — direct group reconciliation): added `forceRemoveOrphanedCovers()` helper that walks `inst._componentsViews -> brush view -> _brushController`, computes `Set(_covers)`, and directly removes any `group.children()` entry not tracked in `_covers`, then calls `zr.refresh()`. This bypasses DataDiffer's `_creatingCover` guard. Called from three sites: (a) echo path at top of `handleBrushSelected` (post-drag cleanup), (b) finally block after the clear dispatch (happy path belt-and-suspenders), (c) end of the lifecycle effect (safety net after mode/generation change). Feedback-loop safety unchanged — echo guard still prevents infinite re-entry.
- Verification post-third-pass: 0 brushselected fires in 5s idle. All scenarios pass with DOM-level confirmation (`groupChildren: 0, ctrlCovers: 0, visibleCovers: 0`): happy path smooth drag, tiny-click isSmall path, mid-drag-pause (the exact user repro), 4 rapid successive drags, mode toggle off->on.

---

## Modal Adapter Redesign — Phase 1 + Phase 2 + Phase 3

**Status:** All implementation complete (2026-04-06 to 2026-04-09). Browser verification pending.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](MODAL_ADAPTER_REDESIGN_PLAN.md) for full plan, commit references, and architecture details.

### Phase 1: Independent Stages + Full Pipeline (6 waves)

Replaces sequential `AdapterState` enum with data-availability checks, per-section "Load Saved" buttons, "Run Full Pipeline" with Stepper progress.

| Wave | Scope | Status |
|------|-------|--------|
| 1 | State machine removal + data checks + ModeChain reconstruction | Done |
| 2 | Measurement persistence + ESPRIT refactor + pipeline method | Done |
| 3 | Offline preset builder (`build_preset_to_file`) | Done |
| 4 | New API endpoints (`GET /modal/data_status`, `POST /modal/run_pipeline`) | Done |
| 5 | Frontend hook (`useModalAdapter` — `dataStatus`, `canRun*` flags, `runPipeline`, `loadIntermediate`) | Done |
| 6 | Frontend UI (`ModalAdapter.jsx` — data-driven enablement, pipeline controls) | Done |

### Phase 2: Server Separation, Projects & UI Overhaul (2026-04-08/09)

| Feature | Commits | Status |
|---------|---------|--------|
| Separate modal adapter server (port 5001, `threaded=False`) | `8fd1226` | Done |
| Project management system (7 CRUD endpoints, project.json storage) | `8fd1226` | Done |
| Synthesis pause/resume (`/pause_synthesis`, `/resume_synthesis`) | `8fd1226` | Done |
| ESPRIT fixes (`_resolve_bands`, null `window_length`, numpy serialization) | `8fd1226` | Done |
| FolderBrowser component (native OS folder picker via tkinter) | `2e55e80` | Done |
| Frontend tab UI (Project/ESPRIT/Tracking/Apply replacing accordions) | `020dbd7` | Done (superseded by Phase 3 toolbar) |
| Per-scenario ESPRIT with checkbox selection + shift-click | `020dbd7` | Done |
| EspritConfig simplification (GPU checkbox + advanced toggle) | `020dbd7` | Done |
| Dual-process launcher (port 5000 + 5001 management) | `020dbd7` | Done |

### Phase 3: Toolbar UI (2026-04-09)

Replaced tab navigation with a compact single-row toolbar: server status chip, project button, pipeline ButtonGroup (ESPRIT/Tracking/Apply with checkmark/spinner status), gear icon for collapsible context-sensitive settings, and play/skip-next buttons (with stop when running). Settings and run buttons removed from section bodies.

| Feature | Status |
|---------|--------|
| Toolbar with pipeline ButtonGroup | Done |
| Server status chip (On/Off, clickable) | Done |
| Project button with name + checkmark | Done (merged into Setup button) |
| Context-sensitive settings panel (gear toggle) | Done |
| Play (run step) + SkipNext (run to end) buttons | Done |
| Stop button overlay when running | Done |

### Phase 4: Merged Setup Panel + Settings Freeze (2026-04-12)

Merged Project and ESPRIT into a unified "Setup" section. Channel roles and ESPRIT config moved to settings/gear panel. All settings freeze (disabled + lock icon) once ESPRIT processing starts.

| Feature | Status |
|---------|--------|
| Merge Project + ESPRIT into unified Setup section | Done |
| Channel roles in settings/gear panel (not section body) | Done |
| ESPRIT config in settings/gear panel alongside channel roles | Done |
| Settings freeze when ESPRIT starts (running or done) | Done |
| Lock icon replaces gear icon when frozen | Done |
| Project creation/import/copy/delete hidden when frozen | Done |
| Setup button shows project name | Done |

### State Management Rewrite (2026-04-13)

Phased elimination of split-brain state between frontend and backend.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Backend `GET /modal/project_state` endpoint | Done |
| 2 | Backend `DEFAULT_CONFIG.preset` → `extended_8band` | Done |
| 3 | Frontend `mappingDirty` tracking for explicit save | Done |
| 4 | Frontend `syncFromBackend()` — single state sync function | Done |
| 5 | Frontend cleanup — dead code, state consolidation, log path fix | Done |

Phase 4 replaced ~200 lines of ad-hoc state restoration across `openProject`, `createProject`, `copyProject`, mount effect, and `addMeasurementsToProject` with a single `syncFromBackend()` function. Every mutation now calls `syncFromBackend()` after success. Removed dead `applyConfig`/`setConfigPreset` (endpoint deleted in Phase 1).

Phase 5 cleanup: removed `onPresetSelect` dead prop from EspritConfig, removed band-preset retry-polling (fetch once on mount instead), consolidated 4 project-related useState calls into grouped `project` state object, removed unused `pct` variable in importProject upload handler, fixed hardcoded log path in modal_adapter `__init__.py` to use system temp directory.

### Bug 3 — Settings relocation to native MosaicWindow toolbar (2026-04-19, dev-aeb0)

The custom inline gear IconButton in the ModalAdapter toolbar row was redundant with the native MosaicWindow title-bar toolbarControls slot. Fix relocates the settings gear/lock to the title bar via `ReactDOM.createPortal` into `.mosaic-window-controls`. A `useLayoutEffect` hook also hides the generic `button[title="Settings"]` that `PianoidTuner.renderToolbarControls` injects for all panes (it was pointing at an empty PropertyManager since "Modal Adapter" has no `settingsMap` entry). Net result: exactly one settings gear in the title bar, wired to ModalAdapter's real settings panel. Freeze/lock behavior preserved; all context-sensitive content (MappingEditor + EspritConfig for Setup, freq tolerance + max gap for Tracking, merge toggle + sound channel mapping for Apply) unchanged. Fully contained in `ModalAdapter.jsx` — no edit to `PianoidTuner.js` required.

### Remaining

- Browser verification of all Phase 1 + Phase 2 + Phase 3 + Phase 4 features
- Browser verification of state management rewrite (project open/create/copy, ESPRIT run, state persistence)
- Independent-stage loading, full pipeline execution, backward compatibility
- Project CRUD workflow, toolbar navigation, per-scenario ESPRIT UI

---

## Extended 8-Band Pipeline Run (2026-04-07/08)

**Status:** ESPRIT + tracking + feedin complete. Preset built, not yet volume-matched.

The `extended_8band_medium` pipeline completed all stages on Belarus piano data:
- **ESPRIT:** 78/78 scenarios, 8210 raw modes, ~56 sec/scenario, ~72 min total
- **Tracking:** 441 chains (210 stable, 133 semi-stable, 64 weak, 34 spurious)
- **Feedin:** 88 pitches (78 measured + 10 interpolated), 441 mode frequencies

A 196-mode preset (`Belarus_8band_196modes.json`) was built from the top 196 stable modes with per-mode normalized feedin (0–1 range) and per-channel output pitch feedback. The preset produces sound but is quieter than BaselineBelorus1 at higher pitches — likely due to different modal content between 4-band and 8-band extractions.

Data: `D:/tmp/belarus_78_extended_8band_medium/`

See [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) and [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) for run details.

Reference presets:
- `presets/BaselineBelorus1.json` (196 modes, 4-band, per-mode normalised feedin)
- `presets/Belarus_8band_196modes.json` (196 modes, 8-band medium, per-mode normalised feedin)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — legacy)

---

## note_playback Chart Auto-Normalization

**Status:** Pending fix.

`ChartData.create_audio()` in `ChartRegistry.py` normalises the WAV audio to 0.8× peak before sending to the frontend, masking silent-output bugs. The chart statistics (max, RMS) are from the raw buffer before normalisation, but the WAV IS normalised. During Belarus preset development, this masked a silent-output bug.

**Fix options:**
1. Report `synthesis_peak` (actual kernel output magnitude) alongside chart stats
2. Add a warning when synthesis_peak is below a threshold
3. Optionally disable auto-normalisation

---

## ASIO Driver Re-initialization Failure

**Status:** Pending fix.

After ASIO callback driver is stopped, re-initialization fails with "no working ASIO device found". Root cause: `AsioAudioOutput::Close()` in `AsioAudioInterface.cpp` doesn't reset global state variables (`asioDriverInfo`, `directOutputFn`, `asioCallbacks`, `queueToPlay`) and the `AsioDrivers` COM singleton is never destroyed/recreated.

**Workaround:** Restart the backend server between ASIO sessions.

---

## Completed Items (archived)

| Item | Status | Notes |
|------|--------|-------|
| Excitation API Mismatch | Fixed | `StringMap.pack_base_excitations()` added to PianoidBasic |
| Parameter Routing Unification | Complete | All routes through `ParameterManager` |
| Playback System Fixes | Complete | 11/14 findings fixed (see tracker below) |
| Microphone-Based Volume Equalization | Implemented | 4-phase calibration across all 3 repos |
| RoomResponse Modal Adapter Integration | Complete | All 4 waves, 6 critical bugs fixed |
| Sound Channel useEffect Feedback Loop | Fixed (re-fixed 2026-04-30) | Initially patched with `scDataRefresh` flag (Apr 2026, dev-sc-tooltip-rowcol). Re-fixed architecturally in dev-833f Phase C2 with the three Frontend State Discipline principles (presetVersion counter, granular per-pitch emits, imperative-at-handler writes). The `scDataRefresh` boolean is removed; consumers re-init via `[presetVersion]`. |
| Second Derivative Sound Output | Resolved | Kernel-level 2nd derivative implemented |

### Playback System — Improvement Tracker

| # | Finding | Status |
|---|---------|--------|
| 1 | Three overlapping stop methods | **Done** |
| 2 | `stop_pianoid()` sleep race condition | **Done** |
| 3 | `long_running_procedure()` dead reference | **Done** |
| 4 | MIDI→EventType mapping duplicated 3× | **Done** |
| 5 | No CUDA error check in online engine | **Done** |
| 6 | `play_mode()` blocking sleep | **Done** |
| 7-10 | Dead code cleanup | **Done** |
| 11 | Double mutex in `RealTimeEventBuffer` | **Done** |
| 14 | No playback integration tests | Pending |

---

## Recently archived

Moved to [archive/](archive/) on 2026-04-25 (`archive-dev-docs`):

| File | Reason |
|---|---|
| [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) | Primary bug fixed (Kernels.cu:155 dt² fix + preset rescale, 2026-04-23). Secondary follow-ups still tracked above under Known Follow-Ups. |
| [archive/PLAYBACK_ARCHITECTURE_REVIEW.md](archive/PLAYBACK_ARCHITECTURE_REVIEW.md) | Research snapshot (2026-04-20). Subsequent cycle orchestration tranches (C1/C2/C3/C8/C10/C11/C12/C13) committed. |
| [archive/CYCLE_ORCHESTRATION_REFINEMENT.md](archive/CYCLE_ORCHESTRATION_REFINEMENT.md) | All proposed tranches (A/B/C2/C3/F5) committed. |
| [archive/DISTORTION_INVESTIGATION_CONTEXT.md](archive/DISTORTION_INVESTIGATION_CONTEXT.md) | Briefing snapshot (2026-04-20), precursor to volume-iter — closed. Live distortion concerns now tracked under Buffer Underrun Investigation. |
| [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md](archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md) | System analysis snapshot (2026-04-06) of mic calibration; implementation listed under Completed Items. |
