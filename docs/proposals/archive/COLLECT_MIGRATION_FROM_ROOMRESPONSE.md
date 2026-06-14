# Collect Sub-Pane Migration from RoomResponse Series Settings

**Status:** Proposal — analysis + phased plan, NOT IMPLEMENTED. Captures the
parameter inventory and migration design produced from a side-by-side study
of the RoomResponse `gui_series_settings_panel.py` (origin/dev,
commit `86e9a15`) and the Pianoid Modal Adapter Collect pane
(`PianoidTunner/src/components/CollectPanel.jsx`,
`PianoidCore/pianoid_middleware/modal_adapter/collection_engine.py`).

The intent is that a `/dev` agent can pick up Phase 1 directly from this doc
without re-reading the RoomResponse source. Phase 2 and Phase 3 require
architectural decisions that are listed in § E.

---

## A. Source-of-truth state

`git pull` on `D:\repos\RoomResponse` (branch `dev`) **conflicted** on
`sdl_audio_core/build_config.json` (auto-generated SDL paths file — local
SDL3 migration vs origin's pre-SDL3 state). The merge was aborted to leave
the working tree clean. The local `dev` branch still has the SDL3 migration
commit (`349b6fb`) unpushed; origin's last 4 commits have been fetched but
not merged. All analysis below uses `origin/dev` as the source of truth.

Recent `origin/dev` commits:

```
3b09427 chore: in-flight updates and measurement-data gitignore hygiene
86e9a15 feat: Series Settings UI overhaul, Test Pulse, Sanity Check view  <-- the panel under study
7a59c56 fix: Correct ESPRIT channel handling and add Merge_res_New.py export
fde640e feat: Add ESPRIT modal analysis integration for scenario collection
8c79333 fix: per-band model orders and memory cleanup between ESPRIT bands
```

Working snapshots used during analysis (kept under `RoomResponse/TMP/`, not
committed):

- `D:\repos\RoomResponse\TMP\series_settings_origin.py` — origin/dev snapshot of `gui_series_settings_panel.py` (2643 lines)
- `D:\repos\RoomResponse\TMP\recorder_origin.py` — origin/dev snapshot of `RoomResponseRecorder.py` (1420 lines)

---

## B. Series Settings panel — full parameter inventory

The panel is a **Streamlit** page (not React), structured into 4 collapsible
groups in `_render_pulse_series_config` (`series_settings_origin.py:933`).
It writes to a shared `RoomResponseRecorder` instance and persists to
`recorderConfig.json` via `config_manager`.

### Group 1 — Mode and Channels Configuration (`series_settings_origin.py:973-977`)

| UI control | Type | Default | Backend attr (RoomResponseRecorder) | UI line | Backend line |
|---|---|---|---|---|---|
| Recording Mode (radio: Standard/Calibration) | str | `'calibration'` | `take_record(mode=...)` parameter; `SingleScenarioCollector` `recording_mode` ctor kwarg | UI 244-293 | recorder 1004-1046; DatasetCollector 92, 699 |
| Calibration sensor channel (display only) | int | from `multichannel_config` | `recorder.multichannel_config['calibration_channel']` | UI 313 | recorder 58-67 |
| Reference channel (display only) | int | 0 | `recorder.multichannel_config['reference_channel']` | UI 316 | recorder 58-67 |
| Enable Normalization (checkbox) | bool | True (cal mode) | `recorder.multichannel_config['normalize_by_calibration']` | UI 322-337 | recorder 58-67 |

### Group 2 — Series Configuration (`series_settings_origin.py:980-1012`)

| UI control | Type | Default | Backend attr | UI line | Backend line |
|---|---|---|---|---|---|
| Number of pulses | int | 8 | `recorder.num_pulses` | UI 983-988 | recorder 45, 178-179 |
| Cycle duration (ms) | float | 100.0 ms | `recorder.cycle_duration` (s) | UI 989-994 | recorder 44, 178-179 |
| Extra record time (ms) | float | 200.0 ms | `recorder.total_duration` (computed: num_pulses × cycle + extra) | UI 996-1002 | recorder 186, 1381-1382 |
| **Calculated** Gap Duration | float | derived | `recorder.gap_samples / sample_rate` | UI 1109-1135 | recorder 185 |
| **Calculated** Series Duration | float | derived | `recorder.total_duration` | UI 1109-1135 | recorder 186 |
| **Calculated** Duty Cycle | float | derived | (display only) | UI 1125 | n/a |
| **Calculated** Pulse Rate | float | derived | (display only) | UI 1127 | n/a |

### Group 3 — Pulse Configuration (`series_settings_origin.py:1015-1027`)

| UI control | Type | Default | Backend attr | UI line | Backend line |
|---|---|---|---|---|---|
| Pulse waveform (selectbox: sine/square/voice_coil) | str | `'sine'` | `recorder.impulse_form` | UI 471-478 | recorder 48, 458-518 |
| Pulse duration (ms) — non-VC only | float | 8.0 ms | `recorder.pulse_duration` (s) | UI 547-555 | recorder 42, 459 |
| Pulse frequency (Hz) — sine only | float | 1000 Hz | `recorder.pulse_frequency` | UI 556-563 | recorder 47, 460 |
| Fade duration (ms) — sine/square | float | 0.0001 ms (UI clamps to 0.05) | `recorder.pulse_fade` (s) → `recorder.fade_samples` | UI 564-570 | recorder 43, 183, 463-467 |
| Pulse volume | float | 0.4 | `recorder.volume` | UI 1017-1022 | recorder 46, 532 |
| Invert polarity | bool | False | `recorder.invert_polarity` | UI 573-577 | recorder 50, 529-530 |
| Smoothing (ms) Hann low-pass | float | 0.0 | `recorder.pulse_smoothing_ms` | UI 578-584 | recorder 51, 521-527 |
| **Voice-coil only** init_pos_ms | float | 0.0 | `recorder.voice_coil_config['init_pos_ms']` | UI 481-487 | recorder 98, 478-491 |
| **Voice-coil only** init_pos_amplitude | float | -0.1 (clamped −0.2…0) | `voice_coil_config['init_pos_amplitude']` | UI 488-496 | recorder 99, 479-491 |
| **Voice-coil only** positive_ms | float | 20.0 | `voice_coil_config['positive_ms']` | UI 497-503 | recorder 100, 480-497 |
| **Voice-coil only** gap_ms | float | 10.0 | `voice_coil_config['gap_ms']` | UI 504-510 | recorder 101, 481-500 |
| **Voice-coil only** negative_ms | float | 100.0 | `voice_coil_config['negative_ms']` | UI 511-517 | recorder 102, 482-505 |
| **Voice-coil only** pullback_amplitude | float | 0.5 (range −1…1) | `voice_coil_config['pullback_amplitude']` | UI 518-526 | recorder 103, 483-505 |
| Test Pulse button (action) | — | — | invokes `recorder._record_audio()` with `num_pulses=1` temporarily | UI 749-928 | recorder 794-876 |

### Group 4 — Post Processing (`series_settings_origin.py:1030-1094`)

| UI control | Type | Default | Backend attr | UI line | Backend line |
|---|---|---|---|---|---|
| Averaging start cycle | int | 2 | `processed_data['metadata']['averaging_start_cycle']`; consumed by `_process_recorded_signal` | UI 1032-1038 | recorder ~570-650 (process_recorded_signal) |
| Enable IR Truncation | bool | False | `recorder.truncate_config['enabled']` | UI 1042-1046 | recorder 88 |
| IR Working Length (ms) | float | 500.0 ms | `recorder.truncate_config['ir_working_length_ms']` | UI 1051-1059 | recorder 89 |
| IR Fade Length (ms) | float | 50.0 ms | `recorder.truncate_config['ir_fade_length_ms']` | UI 1060-1068 | recorder 90 |

### Implicit / not-on-screen-but-config (referenced inside Series Settings via `recorderConfig.json`)

| Key | Type | Default | Where consumed |
|---|---|---|---|
| `sample_rate` | int | 48000 | Sourced from Audio Settings panel; `recorder.sample_rate` used everywhere | recorder 41, 184 |
| `calibration_quality_config` | dict | (15+ thresholds) | Used by calibration-mode validator | recorder 70-84 |
| `save_format` (`save_wav` / `save_npy`) | dict | save_wav=True, save_npy=False | recorder 107-110, 962-963 |
| `multichannel_config.alignment_correlation_threshold` | float | 0.7 | Cycle alignment in calibration processing | recorder 58-67 |
| `multichannel_config.alignment_target_onset_position` | int | 0 | Cycle alignment | recorder 58-67 |

---

## C. Existing Collect sub-pane in Pianoid Modal Adapter

**Frontend:** `D:\repos\PianoidInstall\PianoidTunner\src\components\CollectPanel.jsx`
(mounted in `ModalAdapter.jsx:919-921` as the `"collect"` pipeline section).

**Currently exposed UI fields** (`CollectPanel.jsx:52-59` defaults; controls 198-369):

| Field | Type | Default | Line |
|---|---|---|---|
| Scenario number | int | 0 (range 0-87) | 200-216 |
| Project directory | str | (inherited from project) | 217-228 |
| sample_rate (Hz) | int | 48000 | 254-269 |
| num_pulses | int | 50 | 271-287 |
| volume (0-1) | float | 0.5 | 288-307 |
| num_measurements | int | 8 | 308-323 |
| Input device (select from SDL probe) | int ordinal | "" → fallback | 327-345 |
| Output device (select from SDL probe) | int ordinal | "" → fallback | 346-363 |

**Backend (already plumbed):**
`D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\collection_engine.py`.
The `_build_recorder_config` method at lines **483-504** explicitly accepts
these top-level keys: `sample_rate`, `num_pulses`, `volume`, `input_device`,
`output_device`, `input_device_name`, `output_device_name`. It also passes
`multichannel_config` through verbatim (`collection_engine.py:501-503`). The
`_build_scenario_dict` at lines **551-568** accepts `num_measurements`,
`measurement_interval`, `description`, `computer`, `room`. Everything else in
`recorder_config_overrides` is **silently dropped** by the merge (the
for-loop is allow-listed).

---

## D. Parameter Migration Table

Migration class legend:

- **(1) Already exposed** — done
- **(2) Backend already accepts, UI missing** — Wave B-2 was supposed to do this; mostly NOT done yet for Series Settings parameters
- **(3) Missing from backend AND UI** — needs both layers
- **(4) Doesn't apply / out of scope**

| Series Settings parameter | Type / units / default / range | RoomResponse source | Backend status (collection_engine.py) | Class | Est. LOC | Notes |
|---|---|---|---|---|---|---|
| `sample_rate` | int Hz / 48000 | `recorder_origin.py:41,178` | accepted (line 495) | **(1)** | 0 | Done |
| `num_pulses` | int / 8 (RR), 50 (Pianoid default) | `recorder_origin.py:45,178` | accepted (line 495) | **(1)** | 0 | Done; defaults differ — Pianoid is 50, RR is 8/5 |
| `volume` | float 0-1 / 0.4 | `recorder_origin.py:46,532` | accepted (line 495) | **(1)** | 0 | Done |
| `num_measurements` | int / 30 (RR DatasetCollector), 8 (Pianoid) | `DatasetCollector.py:34,665` | accepted (line 566) | **(1)** | 0 | Done |
| `input_device` / `input_device_name` | int / str / -1 | `recorder_origin.py:200` | accepted (lines 496-497) | **(1)** | 0 | Done |
| `output_device` / `output_device_name` | int / str / -1 | `recorder_origin.py:200` | accepted (lines 496-497) | **(1)** | 0 | Done |
| `multichannel_config` (whole object) | dict | `recorder_origin.py:58-67` | accepted (lines 501-503), no UI | **(2)** | 80-120 | Critical for any non-stereo measurement; today the user must put it in `recorderConfig.json` and restart RoomResponse instead |
| `multichannel_config.calibration_channel` | int / None | `recorder_origin.py:62` | passes through, UI missing | **(2)** | 10 | Single Select MUI control |
| `multichannel_config.reference_channel` | int / 0 | `recorder_origin.py:63` | passes through, UI missing | **(2)** | 10 | Single Select MUI control |
| `multichannel_config.response_channels` | List[int] / [0] | `recorder_origin.py:64` | passes through, UI missing | **(2)** | 30 | Multi-select chip array |
| `multichannel_config.enabled` | bool / False | `recorder_origin.py:59` | passes through, UI missing | **(2)** | 5 | MUI Switch |
| `multichannel_config.num_channels` | int / 1 | `recorder_origin.py:60` | passes through, UI missing | **(2)** | 5 | NumInput |
| `multichannel_config.channel_names` | List[str] / ['Channel 0'] | `recorder_origin.py:61` | passes through, UI missing | **(2)** | 30 | Editable per-row TextField table |
| `multichannel_config.normalize_by_calibration` | bool / False | `recorder_origin.py:66` | passes through, UI missing | **(2)** | 5 | MUI Switch — only meaningful for calibration mode |
| `multichannel_config.alignment_correlation_threshold` | float 0-1 / 0.7 | `recorder_origin.py:58-67` | passes through, UI missing | **(2)** | 5 | NumInput |
| `multichannel_config.alignment_target_onset_position` | int / 0 | `recorder_origin.py:58-67` | passes through, UI missing | **(2)** | 5 | NumInput |
| `description` | str | `DatasetCollector.py:33` | accepted (line 561) | **(2)** | 5 | TextField; trivial UI add |
| `computer` | str / "ModalAdapter" | `DatasetCollector.py:31` | accepted (line 564) | **(2)** | 5 | TextField; affects scenario folder name |
| `room` | str / "Run" | `DatasetCollector.py:32` | accepted (line 565) | **(2)** | 5 | TextField; affects scenario folder name |
| `measurement_interval` | float seconds / 2.0 (RR), 0.5 (Pianoid default) | `DatasetCollector.py:35,659` | accepted (line 567) | **(2)** | 5 | NumInput; Pianoid default 0.5 is too tight for hammer scenarios |
| `pulse_duration` (sine/square) | float seconds / 0.008 | `recorder_origin.py:42,454` | NOT in allow-list (engine merge silently drops) | **(3)** | 8+5 | Backend: add to `_build_recorder_config` allow-list. UI: NumInput |
| `pulse_fade` | float seconds / 0.0001 | `recorder_origin.py:43,183` | NOT in allow-list | **(3)** | 8+5 | Same pattern |
| `cycle_duration` | float seconds / 0.1 | `recorder_origin.py:44,184` | NOT in allow-list | **(3)** | 8+5 | Same pattern; key for sustain/decay capture |
| `pulse_frequency` | float Hz / 1000 (sine only) | `recorder_origin.py:47,460` | NOT in allow-list | **(3)** | 8+5 | Same pattern |
| `impulse_form` | enum sine/square/voice_coil / 'sine' | `recorder_origin.py:48,458` | NOT in allow-list | **(3)** | 8+5 | Drives whole pulse-shape branch |
| `invert_polarity` | bool / False | `recorder_origin.py:50,529` | NOT in allow-list | **(3)** | 8+5 | Trivial |
| `pulse_smoothing_ms` | float ms / 0.0 | `recorder_origin.py:51,521` | NOT in allow-list | **(3)** | 8+5 | Trivial |
| `voice_coil_config` (entire dict) | nested dict / 6 keys | `recorder_origin.py:97-104,470-505` | NOT in allow-list | **(3)** | 15+60 | 6 sub-fields (init_pos_ms, init_pos_amplitude, positive_ms, gap_ms, negative_ms, pullback_amplitude); only meaningful when `impulse_form='voice_coil'` — should be a conditional sub-section |
| `truncate_config.enabled / ir_working_length_ms / ir_fade_length_ms` | dict / (False, 500.0, 50.0) | `recorder_origin.py:87-91`, used in `_process_recorded_signal` | NOT in allow-list, BUT averaging in modal-adapter happens in `scenario_averager.py` not via recorder — different code path | **(3)** | 12+30 | The Modal Adapter has its OWN truncation logic in `scenario_averager.py` (defaults `ir_working_length_ms=600`, `ir_fade_length_ms` per `MODAL_ADAPTER_GUIDE.md:263-264`). DUPLICATE LOGIC — see § E.3 |
| `series_config.record_extra_time_ms` | float ms / 200.0 | series_settings UI 996-1002, written to `recorder.total_duration` | NOT in allow-list | **(3)** | 8+5 | Affects `total_duration` calc; unclear if currently respected because modal-adapter calls collector which calls `take_record` which uses `playback_signal` already generated — the `extra_time` is part of `total_duration` set in `_apply_series_settings_to_recorder` line 1382 of UI. Need to verify behaviour after constructor |
| `series_config.averaging_start_cycle` | int / 2 | UI 1032-1038, used in `_process_recorded_signal` of recorder | Modal-adapter uses `scenario_averager.py` which has its own logic — DUPLICATE | **(3) / (4)** | — | Same as truncate_config: orthogonal averager. See § E.3 |
| `calibration_quality_config` (entire dict, 15+ keys) | dict | `recorder_origin.py:70-84` | passes via recorderConfig.json bundled file only; NOT in `_build_recorder_config` allow-list | **(3)** | 20+200 | LARGE; per-cycle validation thresholds. Only meaningful in calibration mode. Likely deserves its own settings dialog rather than inlining |
| `save_format` (`save_wav`, `save_npy`) | dict / (True, False) | `recorder_origin.py:107-110` | passes via bundled recorderConfig.json only | **(3)** | 6+10 | Two checkboxes; affects what files end up in scenario subdir |
| **Recording mode** (`'standard'` vs `'calibration'`) | str / 'standard' | `take_record(mode=...)` `recorder_origin.py:1008`; `SingleScenarioCollector(recording_mode=...)` | **NOT plumbed** — `collection_engine.py:328-335` doesn't pass it; `_invoke_collection` always uses default 'standard' | **(3)** | 12+10 | Must add `recording_mode` to `collector_factory(...)` call; surface as Radio in UI |
| Test Pulse button (action) | action | UI 749-928 | NO equivalent endpoint | **(3)** | 60+80 | Optional in Phase 1; nice-to-have for sensor diagnosis. Could re-use existing `take_record` machinery but would need a new POST route + temporary 1-pulse override |
| Save Configuration / Reset to Saved buttons | actions | UI 1146-1163 | n/a — Pianoid uses preset-based persistence | **(4)** | — | Out of scope. Pianoid persists per-project via `mapping_config.json` etc., not via global `recorderConfig.json` |
| Calibration Mode info card (sensor display, normalization toggle) | informational | UI 295-356 | requires `multichannel_config` to be exposed first | **(2)** | 40 | Renders once channels are exposed |
| Mode Comparison table (educational) | informational | UI 358-387 | n/a | **(4)** | — | Optional documentation; could go in MODAL_COLLECTION.md instead |
| Recorder Snapshot panel (read-only metrics) | informational | UI 2566-2612 | already partially in CollectPanel via status chip | **(4)** | — | Mostly out of scope; the equivalent is the project's measurements list |
| Cycle Consistency Overlay / Recording Analysis charts | post-recording analysis | UI 1531-2510 | NO equivalent — Pianoid hands off to ESPRIT immediately | **(4)** | — | OUT OF SCOPE for Collect: this is downstream visualisation. The Modal Adapter's natural place for it is the ESPRIT/Tracking sections, which already have stab diagrams. Consider as a separate "Inspect Last Recording" panel later |
| Sanity Check view (A/B half split overlay) | post-recording analysis | added in commit 86e9a15 | NO equivalent | **(4)** | — | Same as above — analysis surface, not collection surface |

---

## E. Architectural decisions the user needs to make

### E.1 Collect-pane scope: subsume RoomResponse entirely or coexist?

The Collect panel currently runs RoomResponse-the-library *out-of-process*
(the modal_adapter_server imports `RoomResponseRecorder` and
`SingleScenarioCollector` from the sibling repo via
`_room_response_bootstrap.py`). Question: should RoomResponse remain a
**standalone Streamlit tool the operator runs separately for sensor R&D**,
or should the Pianoid Collect pane become the only entry point and the
Streamlit GUI be retired? My read of the existing scope: keep both, because
Series Settings has a deep "post-recording analysis" surface (overlays,
sanity-check, spectrum) that doesn't belong inside the Modal Adapter
pipeline. **Recommendation: coexist. Migrate only what affects collection
inputs, leave analysis-only widgets in Streamlit.**

### E.2 Session-metadata vs scenario-metadata

RoomResponse stores `computer` / `room` / `description` per scenario folder
name (`{computer}-Scenario{N}-{room}`). The Pianoid project model stores
measurements as `scenario_N.npy` inside the project's `measurements/`
directory; the RoomResponse-style hierarchical folder is also kept in
`{project}/{computer}-Scenario{N}-{room}/`. The user should decide if these
strings should:

- (a) Be exposed per-collection in the Collect UI (current state — possible via overrides but no UI),
- (b) Be project-level defaults stored in `mapping_config.json` (or `project.json`) and inherited by every Collect call,
- (c) Be auto-derived (e.g. `computer = hostname`, `room = projectname`).

I'd recommend **(b)** — these belong in the project, not in every scenario form.

### E.3 DUPLICATE truncation/averaging logic

Both `RoomResponseRecorder._process_recorded_signal` and Pianoid's
`scenario_averager.py` (referenced by `MODAL_ADAPTER_GUIDE.md:267`) average
and truncate IRs. RoomResponse uses
`truncate_config.{enabled, ir_working_length_ms=500, ir_fade_length_ms=50}`;
Pianoid's averager uses `ir_working_length_ms=600`. **Today these can
drift independently.** Three options:

- Surface the modal-adapter `scenario_averager.py` knobs in Collect UI (the parameters that actually run on Pianoid-collected data), and treat the RR `truncate_config` as historical/deprecated for the Pianoid path.
- Make Pianoid's `scenario_averager.py` honour the bundled `recorderConfig.json` `truncate_config` block so the same value drives both tools.
- Migrate the RR `truncate_config` UI verbatim and have it write through to whichever averager runs.

**Recommendation: option 1** (surface the actual-running averager's knobs,
deprecate the duplicate). Otherwise the operator sets `ir_working_length_ms=400`
in the Pianoid UI and is silently surprised that `scenario_averager.py`
truncated to 600.

### E.4 Calibration mode plumbing

RR's Series Settings has a top-level Standard/Calibration radio that drives
`take_record(mode=...)`. The Modal Adapter
`collection_engine.py:_invoke_collection` does NOT pass this mode through,
so calibration is **silently unavailable** from the Pianoid frontend even
though the bundled `recorderConfig.json` has `calibration_channel: 2`
configured. **Decision: do we want calibration mode in the Pianoid Collect
path?** If yes, this is a Phase 1 add (3-line `collection_engine` change +
a UI toggle). If no, document it as out of scope and clean up the dead
`multichannel_config.calibration_channel` bookkeeping.

### E.5 Pulse-shape parameters: who owns them?

The current Pianoid Collect UI doesn't expose any pulse-shape knob. The
shape is implicitly whatever `recorderConfig.json` ships with (currently
`voice_coil` per the file). For users who don't run RoomResponse-the-Streamlit-tool,
**there is no way to switch from voice_coil back to sine/square** — they
have to hand-edit JSON. Decision: should pulse shape be (a) exposed inline
in Collect, (b) hidden in an "Advanced" expander, or (c) project-level (set
once per project, then re-used)?

### E.6 Test Pulse / sensor diagnosis

RoomResponse's "Test Pulse" button is a critical sensor-diagnosis tool — it
emits a single pulse, captures one calibration channel, and overlays them.
Without this, the operator commits a 30-measurement scenario only to
discover the sensor was unplugged. Decision: **port it to Phase 2 in the
Collect pane**, add a `POST /modal/collect/test_pulse` endpoint, or reroute
the operator to the Streamlit tool for sensor checks?

### E.7 DUPLICATE-but-renamed parameters

- **`series_pulse_duration` (UI, ms) ↔ `pulse_duration` (config, s) ↔ `recorder.pulse_duration` (attr, s)** — already a unit-conversion landmine inside RoomResponse. If we expose pulse_duration in Pianoid Collect, **pick one unit (ms) and stick to it across UI and JSON**. The 1000.0× conversion in `_init_session_state` (UI lines 99-104) is a smell.
- **`measurement_interval` semantic drift** — RR Streamlit UI surfaces it as "interval mode: Start→Start vs End→Start" (worker thread) but the modal-adapter `_build_scenario_dict` at line 567 uses a flat float. The two interval semantics aren't currently visible in Pianoid.

### E.8 Hardware-driver coupling

RoomResponse directly imports `sdl_audio_core` (the local pybind11 module
built via `setup_dev.ps1`). Pianoid's Collect path goes through
`_room_response_bootstrap.py` which adds RoomResponse to `sys.path` and
imports the same module. Both share the audio device — hence the
`pause_synthesis` / `resume_synthesis` dance. **Open question:** when the
SDL3 migration commit (`349b6fb`) is finally pushed and merged on
`origin/dev`, the `sdl_audio_core` module changes its surface — does the
Pianoid bootstrap need any update? Worth a one-line check in
`_room_response_bootstrap.py`.

---

## F. Migration plan — phased

### Phase 1 — Class (2): UI plumbing for backend-already-supported parameters

**Backend changes: zero.** All these are already in `_build_recorder_config`
(`collection_engine.py:483-504`) or `_build_scenario_dict`
(`collection_engine.py:551-568`).

Add to `CollectPanel.jsx` (and update the `recorderConfig` object built in
`handleStart` lines 119-133):

1. **Multi-channel section** (collapsible, default-closed unless `multichannel_config.enabled` is true):
   - `enabled` Switch (~5 LOC)
   - `num_channels` NumInput (~5)
   - `channel_names` editable list (~30)
   - `calibration_channel` Select (one of `0..num_channels-1`, plus "None") (~10)
   - `reference_channel` Select (~10)
   - `response_channels` multi-select chips (~30)
   - `normalize_by_calibration` Switch (~5)
   - `alignment_correlation_threshold` NumInput (~5)
   - `alignment_target_onset_position` NumInput (~5)

2. **Scenario metadata section** (one-row `<Stack>`):
   - `description` TextField (~5)
   - `computer` TextField (~5)
   - `room` TextField (~5)
   - `measurement_interval` NumInput (seconds, 0.1-10) (~5)

3. **Plumbing: pass these new fields into `recorderConfig`** in `handleStart`
   — about 15 LOC of object spread and conditional includes.

**Total Phase 1 LOC: ~150 frontend, 0 backend.** Single PR scope. A `/dev`
agent can ship this in one session — the contract is fully covered by
`MODAL_COLLECTION.md` § "Recorder Configuration Overrides (v1)". Includes a
unit/integration test that the multichannel block round-trips through the
REST `recorder_config` envelope (test the
`collection_engine._build_recorder_config` merge behavior, which has tests
already at `PianoidCore/tests/.../test_collection_engine.py` if present —
verify and extend).

### Phase 2 — Class (3) cleanly mapping to existing recorder pipeline

**Adds to `_build_recorder_config` allow-list (`collection_engine.py:495`):**

```python
for key in ("sample_rate", "num_pulses", "volume",
            "input_device", "output_device",
            "input_device_name", "output_device_name",
            # NEW:
            "pulse_duration", "pulse_fade", "cycle_duration",
            "pulse_frequency", "impulse_form",
            "invert_polarity", "pulse_smoothing_ms",
            "voice_coil_config", "truncate_config",
            "save_format", "calibration_quality_config"):
```

That's a ~10-line backend change. Plus `_build_scenario_dict` doesn't change.

**Add to `_invoke_collection`** (`collection_engine.py:328-335`): pass
`recording_mode=cfg.get('recording_mode', 'standard')` to
`collector_factory(...)`. ~3 LOC.

**Frontend additions to `CollectPanel.jsx`:**

1. **Recording mode** Radio (Standard / Calibration) (~10) — disable Calibration when no `calibration_channel` is set.
2. **Pulse shape sub-section** (collapsible, default closed):
   - `impulse_form` Select (sine / square / voice_coil) (~10)
   - Conditional `pulse_duration_ms` NumInput (sine/square only; convert to seconds in handleStart) (~10)
   - Conditional `pulse_frequency_hz` NumInput (sine only) (~10)
   - `pulse_fade_ms` NumInput (~10)
   - `cycle_duration_ms` NumInput (~10)
   - `invert_polarity` Switch (~5)
   - `pulse_smoothing_ms` NumInput (~5)
   - Conditional voice_coil sub-block (6 NumInputs + 1 Slider) (~60)
3. **IR truncation sub-section** (conditional on `truncate_config.enabled`):
   - `enabled` Switch (~5)
   - `ir_working_length_ms` NumInput (~5)
   - `ir_fade_length_ms` NumInput (~5)
   - **NOTE:** ties into Architectural Decision § E.3 — choose path before shipping.

**Total Phase 2 LOC: ~150 frontend, ~15 backend.** Two-PR scope (one for
backend allow-list expansion + recording_mode plumbing + tests; one for
the UI). Both PRs ought to land together; recommend a single `/dev` session.

### Phase 3 — Class (3) needing bigger architectural changes

1. **`calibration_quality_config` editor.** 15+ thresholds. Should be its own MUI Dialog ("Calibration Quality Settings") with collapsible groups (negative-peak, positive-peak, aftershock, validation). Backend: just plumb the dict through (3 LOC) — the recorder consumes it natively. **Frontend: ~200 LOC.** Separate `/dev` session.

2. **Series duration `record_extra_time_ms`.** Need to verify what actually happens in the modal-adapter path: the recorder's `_apply_series_settings_to_recorder` is called from the Streamlit UI but NOT from the modal-adapter `_invoke_collection` (the recorder is constructed from the temp config file with default constructor logic, which sets `total_duration = cycle_duration * num_pulses` at `recorder_origin.py:186` WITHOUT the extra time). **This is a bug-or-by-design ambiguity** — needs measurement before adding the UI control. Likely a 5-line backend fix to honour an `extra_time_ms` override in `_build_recorder_config` and call `_generate_complete_signal` after, plus a UI NumInput.

3. **`series_averaging_start_cycle` reconciliation.** As noted in § E.3, this duplicates `scenario_averager.py` logic. Decide first, then implement. Either plumb through to RR's averaging (and skip Pianoid's averager), or expose Pianoid's averager knobs instead.

4. **Test Pulse button.** New `POST /modal/collect/test_pulse` endpoint that calls `take_record` with temporary single-pulse override. Returns emitted + recorded waveforms (~80 backend LOC for the route + serialisation). Frontend overlay chart using ECharts (~100 LOC). Requires careful synth-pause/resume coordination since it opens the audio device.

5. **`save_format` toggle.** Trivial backend (already in `recorderConfig.json`). UI: 2 checkboxes. ~10 LOC.

### Out of scope / decision-needed (Class 4)

- Recording analysis (Cycle Consistency Overlay, Sanity Check, raw signal chart, spectrum view) — belongs in a separate "Inspect Recording" pane or stays in the standalone Streamlit tool.
- `Save Configuration` / `Reset to Saved` — Pianoid uses project-bound persistence, not a global `recorderConfig.json`.
- "Mode Comparison" educational table — move to `MODAL_COLLECTION.md` docs.
- "Recorder Snapshot" debug panel — replaced by Modal Adapter's existing project status chips.

---

## G. Open questions for the user

1. **Coexist or subsume?** (§ E.1) — confirms whether to migrate analysis surfaces or leave them in Streamlit.
2. **Where do `computer` / `room` / `description` live?** (§ E.2) — per-collection field, project-level default, or auto-derived?
3. **Truncation/averaging duplication strategy?** (§ E.3) — surface real averager (`scenario_averager.py`) knobs OR have averager honour bundled `recorderConfig.json`?
4. **Calibration mode in Pianoid?** (§ E.4) — yes (Phase 1 add) or no (deprecate `calibration_channel` from Pianoid path)?
5. **Pulse-shape parameter location?** (§ E.5) — inline in Collect, in an Advanced expander, or project-level?
6. **Test Pulse button: port it?** (§ E.6) — Phase 2 (own endpoint), reuse Streamlit, or skip?
7. **Phase 1 only, or Phase 1+2 in a single push?** Phase 1 is purely UI plumbing for backend-already-supported overrides — very low risk. Phase 2 expands backend allow-list and adds `recording_mode` plumbing. Both are still "small" by `/dev` standards.
8. **Streaming progress.** RR Streamlit shows a progress bar with per-measurement messages. The Modal Adapter `GET /modal/collect/status` only reports `progress_pct` percentages. Want richer progress messages (e.g. "measurement 4/8") plumbed back? Trivial backend change but cross-cutting.

---

## Cross-references

- [`docs/guides/MODAL_ADAPTER_GUIDE.md`](../../guides/MODAL_ADAPTER_GUIDE.md) — pipeline architecture + auto-averaging contract
- [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](../../modules/pianoid-middleware/MODAL_COLLECTION.md) — REST surface + Wave B-1 override allow-list
- [`docs/modules/pianoid-middleware/REST_API.md`](../../modules/pianoid-middleware/REST_API.md) § `/modal/collect/*` endpoints
- `D:\repos\PianoidInstall\PianoidTunner\src\components\CollectPanel.jsx` — current frontend
- `D:\repos\PianoidInstall\PianoidTunner\src\modules\ModalAdapter.jsx:919-921` — mounts CollectPanel
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\collection_engine.py` — backend session orchestrator + recorder-config merge
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\scenario_averager.py` — Pianoid's parallel averaging implementation (DUPLICATE of RR truncation logic — see § E.3)
- `D:\repos\RoomResponse\gui_series_settings_panel.py` — the Streamlit panel under study
- `D:\repos\RoomResponse\RoomResponseRecorder.py` — the recorder backend
- `D:\repos\RoomResponse\DatasetCollector.py` — `SingleScenarioCollector` with `recording_mode` ctor kwarg
- `D:\repos\RoomResponse\recorderConfig.json` — bundled defaults schema
