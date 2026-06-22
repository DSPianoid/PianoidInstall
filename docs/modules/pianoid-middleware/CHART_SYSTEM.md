# pianoid_middleware — Chart System

## Overview

The chart system renders simulation data as JSON arrays for the web frontend. It is built from five interconnected files:

- `ChartRegistry.py` — data model classes (`ChartData`, `ChartArray`, `ChartParameter`, `ChartType`, `ChartTypeRegistry`)
- `chart_config.json` — persistent registry of all chart types and actions
- `ChartGenerator.py` — `ChartGenerator` and `ActionPerformer` entry-point classes
- `chartFunctions.py` — standalone computation functions, one per chart type
- `actionPerformer.py` — (file does not exist separately; `ActionPerformer` is defined in `ChartGenerator.py`)

---

## Architecture

```
  REST request: POST /get_chart_test
       {chartType: "sound", length: 48000}
              |
              v
     backendServer.py
     chart_registry.get_type("sound", "chart")
              |
              v  returns ChartType object
     ChartGenerator(pianoid, chartType=<ChartType>, length=48000)
              |
              | __init__: chart_type_obj.extract_arguments(**kwargs)
              |           (type conversion + validation)
              v
     ChartGenerator.get_response()
              |
              | load_function("chartFunctions", "sound_function")
              | func(pianoid, length=48000, channel=0)
              v
     chartFunctions.sound_function(pianoid, **kwargs)
              |
              | builds ChartArray, appends ChartData objects
              | optionally creates base64 audio
              v
     (ChartArray, top_header, text_fields)
              |
              v
     ChartGenerator.form_response(top_header, text_fields)
              |
              v
     JSON response to frontend:
     {data, general_header, text_fields, chart_headers, audio_data}
```

---

## ChartRegistry.py — Data Model Classes

### `ChartData`

Holds a single numeric array and optional audio.

| Method | Description |
|--------|-------------|
| `__init__(header, data)` | Accepts `np.ndarray` or list; computes statistics immediately |
| `get_chart_statistics()` | Computes min/max values and their positions (excludes NaN) |
| `scale_to_onedig()` | Scales data to single-digit magnitude using powers of 10 |
| `scaled_header()` | Returns `"<header> max value <max_val>"` |
| `get_chart()` | Returns `(header, data.tolist(), audio)` |
| `get_scaled_chart()` | Returns scaled version with modified header |
| `create_audio(sample_rate, duration, amplitude_scale, direct, frequency_scale)` | Encodes data as base64 WAV. `direct=True` uses data as raw PCM; `direct=False` sonifies data by mapping values to frequencies. |

### `ChartArray`

Container for multiple `ChartData` objects.

| Method | Description |
|--------|-------------|
| `append_chart(header, data)` | Creates and appends a `ChartData` |
| `get_data(scaled=False)` | Returns `(headers[], datas[], audio_records[])` across all charts |
| `create_audio_to_chart(chartNo, sample_rate)` | Calls `create_audio()` on specified chart indices (`chartNo='all'` processes every chart), attaching a base64 WAV that drives the frontend's per-chart [AudioPlayer widget](#chart-native-audio-playback-dev-chartplay-2026-05-31). |

### `ChartParameter`

Describes a single parameter for a chart type. Types: `"string"`, `"number"`, `"int"`, `"float"`, `"boolean"`, `"choice"`. Choice parameters require a `choices` list. `get()` returns a JSON-serializable dict.

### `ChartType`

Describes one chart type or action type.

| Attribute | Description |
|-----------|-------------|
| `chart_name` | Unique name (registry key) |
| `label` | Human-readable label for UI |
| `processing_function` | String name of function in `chartFunctions.py` |
| `item_type` | `"chart"` or `"action"` |
| `parameters` | List of `ChartParameter` objects |

| Method | Description |
|--------|-------------|
| `add_parameter(**kwargs)` | Adds a `ChartParameter` |
| `extract_arguments(**kwargs)` | Validates and type-converts kwargs against parameter definitions; fills in defaults for missing values |
| `get_name()` | Returns `chart_name` |
| `get_parameters()` | Returns dict for JSON serialization |

### `ChartTypeRegistry`

Global registry. Registry keys use the format `"<item_type>@<name>"`.

| Method | Description |
|--------|-------------|
| `__init__()` | Loads from `chart_config.json`; creates the file with a minimal bootstrap entry if it does not exist |
| `register_type(chart_type)` | Adds a `ChartType` to `self.types` |
| `get_type(name, item_type="chart")` | Retrieves by name and item_type |
| `get_all_types()` | Returns all registered types |
| `get_charts()` | Returns only `item_type == "chart"` entries |
| `get_actions()` | Returns only `item_type == "action"` entries |
| `get_all_type_names()` | Returns `{"charts": [...], "actions": [...]}` |
| `get_chart_names()` | List of chart names only |
| `get_action_names()` | List of action names only |
| `graph_names_json()` | Returns chart types as list of `get_parameters()` dicts |
| `action_names_json()` | Returns action types as list of `get_parameters()` dicts |
| `get_combined_json()` | Returns `{"graphs": [...], "actions": [...]}` |
| `sync_config_file()` | Appends to `chart_config.json` any registry entries not already present; returns count of new items added (or -1 on error) |

---

## chart_config.json — Registered Types

The file contains 27 entries: 16 chart types, 9 action types, and 2 dynamic_chart types.

### Chart Types

| Name | Function | Key Parameters |
|------|----------|----------------|
| `sound` | `sound_function` | `length` (default 240000), `channel` (default 0) |
| `string_shape` | `string_shape_function` | `pitch_no`, `string_no`, `mode_no`, `block_no` (all default -1) |
| `feedin` | `feedin_function` | `pitch_no` (default -1), `string_no` (default -1) |
| `filter_test` | `filter_test_function` | `mode` (choice: pianoid/pulses/harmonic), `num_outputs`, `num_inputs`, `length`, `save_path`, `load_from_file`, `stop_pianoid`, `block_no`, `filter_file_no` |
| `block_output_data` | `block_output_data_function` | `record_name` (choice: 10 GPU debug records, default "Raw Coefficients"), `block_no` (default 0) |
| `profiling` | `profiling_data_function` | `cpu_file`, `gpu_file`, `auto_stop`, `auto_write`, `show_filter` |
| `mode_test` | `mode_test_function` | `mode_index`, `velocity`, `duration_ms`, `display_length_ms`, `coupling`, `view_mode` (mode_state/synth_audio/mic_audio). The legacy `mode_playback` / `pure_mode_test` chart names forward here via deprecated shims (`play_mode_chart_function` / `pure_mode_test_function`) |
| `note_playback` | `play_note_offline_chart_function` | `pitch`, `velocity`, `duration_ms`, `display_length_ms` |
| `test_volume_parameters` | `test_volume_parameters_function` | `max_volume` (float, default 8000.0), `volume_level` (default 80) |
| `feedback_diagnostic` | `feedback_diagnostic_function` | `pitch_no` (default 60), `num_modes` (default 50) |
| `hammer_shape` | `hammer_shape_function` | `pitch_no` (default 60) |
| `hammer_temporal` | `hammer_temporal_function` | `pitch_no` (default 60), `velocity` (default 100) |
| `online_midi_chart` | `online_midi_playback_chart_function` | `midi_file` (choice), `start_delay_ms`, `capture_length`, `channel` |
| `tuning_report` | `tuning_report_function` | `type` (choice: frequency/volume/both, default both) |
| `cfl_ratio` | `cfl_ratio_function` | `key_range` (choice: all/from21to108/output, default "all") |
| `sound_test` | `sound_test_function` | `mode` (choice offline/online), `play_kind` (note/chord/sequence), `pitches`/`velocities`/`note_durations_ms` (CSV), `tail_ms`, `display_length_ms`, `channels`, `include_kernel`/`include_fir`/`include_sint`/`include_mic` (source toggles), `include_profiling` (add-kernel device time + full-cycle/sync-wait checkpoint decomposition + underrun markers, online-only), `include_spectrum` (FFT magnitude per source), `include_time_axis` (real ms axis + mic align + zoom-sync), `include_full_result` |

### Action Types

| Name | Function | Description |
|------|----------|-------------|
| `add_action_type` | `add_new_type_action` | Registers a new action type in the registry |
| `add_chart_type` | `add_new_type_action` | Registers a new chart type in the registry |
| `filter` | `filter_action` | Toggles FIR filter on/off and optionally loads a filter file |
| `profiling_start` | `profiling_action` | Starts, stops, or resets GPU/CPU profiling |
| `live_play` | `toggle_engine_action` | Toggles real-time playback on/off |
| `play_note_offline` | `play_note_offline_action` | Synthesizes a single note offline to a WAV file |
| `audio_driver_test` | `audio_driver_test_action` | Tests audio driver with sinewave or synthesis engine |
| `online_midi_playback` | `online_midi_playback_action` | Controls online MIDI file playback (start/stop/status) |
| `auto_tune` | `auto_tune_action` | Runs automatic frequency and/or volume tuning (from `auto_tuner.py`) |

---

## ChartGenerator and ActionPerformer (ChartGenerator.py)

### `ChartGenerator`

```
ChartGenerator(pianoid, chartType=<ChartType>, **kwargs)
```

- `__init__`: validates `chartType` is a `ChartType` object, calls `extract_arguments(**kwargs)` to type-convert and default-fill parameters.
- `get_response()`: calls `load_function("chartFunctions", processing_function)`, invokes it as `func(pianoid, **processing_arguments)`, then calls `form_response()`.
- `form_response(top_header, text_fields, scaled=False)`: calls `charts.get_data(scaled)` and assembles the final dict.
- `__str__()`: prints chart type name and resolved parameters.

### `ActionPerformer`

```
ActionPerformer(pianoid, action_type=<ChartType>, **kwargs)
```

- `__init__`: validates `action_type`, calls `extract_arguments`. For `add_action_type` and `add_chart_type` actions, also stores `chart_registry`, `item_type`, and `parameters` in `processing_arguments`.
- `execute()`: calls `load_function("chartFunctions", processing_function)`, invokes it as `func(pianoid, **processing_arguments)`. Returns the message from the function, or `"OK"` if the function returns `None`.

### `load_function(module_name, func_name)`

Dynamically imports `func_name` from `module_name` using `importlib.import_module`. Raises `ImportError` if not found, `TypeError` if not callable.

---

## chartFunctions.py — Computation Functions

Each function has signature `(pianoid, **kwargs)` and returns `(ChartArray, top_header, text_fields)`.

| Function | What it retrieves |
|----------|-------------------|
| `sound_function` | Fetches fresh audio from circular buffer via `get_sound_from_pianoid()`, then `get_sound()` — supports 1D and 2D (multi-channel) arrays; attaches direct WAV audio |
| `string_shape_function` | `pianoid.result.get_pianoid_state()` — string displacement array from GPU; selects by pitch, string, block, or all |
| `feedin_function` | `pianoid.sm.pack_deck()` — deck feed-in coupling array for a pitch/string index |
| `filter_test_function` | Runs CUDA FIR filter test via `FirFilterTest.filter_test()`; can generate test signals or use live sound; saves/loads filter files |
| `block_output_data_function` | Fetches debug output buffers from CUDA. Records 0–1 from string_states (block-indexed). Records 2–9 from output_data: block-indexed records (2,3,6,7,8) show single block view; string-indexed records (4,5,9) show one chart per string in block. Text fields include block layout info (string IDs, pitches, per-string point counts, total points vs array_size, min/max values) |
| `profiling_data_function` | Reads CPU/GPU profiling CSV files and charts timing data |
| `play_mode_chart_function` | Triggers offline mode playback via `0xF1` event, captures mode oscillation and generated sound via `_load_offline_sound_to_result()`. Charts are normalized (divided by peak) for display; raw max/RMS values are reported in text fields. Audio playback uses unnormalized data |
| `play_note_offline_chart_function` | Renders a single note offline, returns audio waveform via `_load_offline_sound_to_result()` |
| `test_volume_parameters_function` | Tests volume coefficient calculation |
| `feedback_diagnostic_function` | Plots feedback coefficients across modes for a pitch |
| `hammer_shape_function` | Retrieves spatial hammer force profile for a pitch |
| `hammer_temporal_function` | Retrieves temporal hammer force envelope for a pitch and velocity |
| `online_midi_playback_chart_function` | Starts MIDI file, waits, captures audio result |
| `pure_mode_test_function` | Excites a single mode via `exciteMode()` + offline playback, reads sound via `_load_offline_sound_to_result()`. Coupling off: deck matrix zeroed for pure damped oscillator. Coupling on: full string-mode interaction. Normalized output with frequency measurement via zero-crossings |
| `sound_test_function` | Multi-source audio-diagnostic overlay (dev-stest-4a7c, 2026-05-31). Renders up to 4 selectable sources for the same note/chord/sequence on a shared time axis — see **Sound Test diagnostic chart** below |
| `cfl_ratio_function` | Per-pitch FDTD CFL stability ratio across the keyboard — plots the worst-string **Courant number** (`coeff_tension − 8·coeff_bending`), the actual CFL ratio that VARIES per pitch (each pitch's headroom below the edge). **NB it does NOT plot `max\|g\|`**: `max\|g\|` is degenerate-flat at exactly `1.0` for every stable string → a useless flat line (revised 2026-05-30 after the user saw the flat chart). **PURE-PYTHON / HOST-side**: per pitch calls `pianoid.param_manager._pitch_upload_amp(pitch)` → `(max\|g\|, worst_string_index, Courant)` from the SAME closed-form the live gate uses (`cfl_stability.amp_and_courant_for_pitch_strings` over the current `StringMap` physics, honouring per-string `tension_offset`; output pitches ≥128 → `(1.0, 0, 0.0)` sentinel). NO GPU/engine/debug build; `cfl_stability.py` is NOT modified. Returns a **4-tuple** `(charts, header, text_fields, {"render_hints": [...]})` — a scatter chart with explicit pitch x-axis, the redline `threshold` at `CFL_LIMIT = 1.0` (Courant = 1, the stability edge), and the `CFL_MARGIN` reject-threshold marker via the additive `thresholds` array (read **live**). Per-point colour follows the gate's ACTUAL decision (`cfl_stability.is_stable_with_margin`): `Courant < CFL_MARGIN` AND `max\|g\| ≤ 1` → allowed (teal/circle), else rejected (red/diamond). Tooltip: `{note, pitch, courant, decision, max_g, worst_string}`. Degenerate (non-finite Courant) → NaN gap + rejected. `key_range`: `all` / `from21to108` / `output`. Unit test: `tests/unit/test_cfl_ratio_chart.py` (mocked `param_manager`, no engine, 13/13); real-preset varies-proof: `docs/development/diagnostics/dev-7032-cfl-courant-varies.py` |

**Offline chart sound-readout path.** Offline chart functions render with
`PlaybackConfig.audio_enabled = False`, which skips `manageSoundBuffers()` in
`PlaybackCycleExecutor::executeCycle` so nothing reaches the speakers. That same
skip also bypasses `appendRawSound()`, leaving the `rawSoundBuffer` that
`PianoidResult.get_sound_from_pianoid()` reads empty. Offline chart functions
therefore call the local `_load_offline_sound_to_result(pianoid)` helper, which
reads the offline engine's `getRecordedAudio()` output (populated by
`OfflinePlaybackEngine::collectAudio()` cycle-by-cycle into channel 0) and writes
it into `pianoid.result.sound` with shape `(num_channels, N)`. Live/online charts
(`sound_function`, etc.) continue to use `get_sound_from_pianoid()` — their raw
buffer is filled normally by `playSoundSamples()`.

---

## Sound Test diagnostic chart (dev-stest-4a7c, 2026-05-31)

The `sound_test` chart (`sound_test_function`) renders the same note / chord /
sequence through up to **4 selectable audio taps** on one shared time axis, so the
operator can compare the signal at successive points in the output pipeline. Each
selected source × channel pair becomes its own chart entry (with its own
[playback widget](#chart-native-audio-playback-dev-chartplay-2026-05-31)).

| Source toggle | Buffer | PianoidResult accessor | Availability |
|---------------|--------|------------------------|--------------|
| `include_kernel` | `dev_soundFloat` — raw kernel output, **pre-FIR, pre-volume** | `result.get_synth_audio()` | offline + online |
| `include_fir` | `dev_filteredSoundFloat` — **post-FIR** float (hardwired stereo) | `result.get_post_fir_audio()` (`load_post_fir_audio_from_pianoid`) | online + `FIRfilterON` only |
| `include_sint` | `dev_soundInt` — **post-volume `Sint32`** buffer the audio driver consumes | `result.get_sint_audio()` (`load_sint_audio_from_pianoid`, stored `np.int32` so overflow/saturation is visible) | online only |
| `include_mic` | live microphone capture during playback | `result.get_mic_audio()` | online + `audio_on` + mic checkbox |

**Architectural contract.** The chart function reads **every** source through a
PianoidResult accessor — it never calls the raw C++ getters
(`getRawSoundRecord`, `getRawFilteredFloatRecord`, `getRawSoundRecordInt`,
`getRecordedAudio`); those are transport primitives owned by the loader methods.
`tests/unit/test_sound_test_chart.py` asserts this structurally via
`assert_not_called()` on each raw-getter mock.

**Modes.** `mode="offline"` runs the deterministic `runOfflinePlayback` path
(only `kernel` populates; `fir`/`sint`/`mic` report **Unavailable** in
`text_fields`). `mode="online"` drives the live audio driver so the FIR / Sint
host rings fill and mic capture can run (requires `audio_driver_type` 2/3/4 — an
`audio_off` backend returns an error). Unselected/empty source set returns a
Notice rather than rendering. The `dev_soundInt` tap is the only Python/REST path
to the post-volume buffer — every other readout returns pre-volume float — so
this chart is the canonical way to observe driver-input clipping/overflow.

### Profiling overlay — kernel cycle timing + underrun markers (dev-profchart, 2026-06-19)

An opt-in `include_profiling` boolean adds a **performance** chart to the Sound
Test set, alongside the audio-tap charts. Scope: per-cycle PURE GPU-kernel
device time + over-budget/underrun markers, rendered entirely through the existing
[`render_hints`](#optional-render_hints--richer-chart-rendering-dev-ratiochart-2026-05-24)
contract (no new frontend component).

> **Series switched to pure kernel device time (dev-underrun2, 2026-06-19).** The
> chart originally plotted the **full-cycle host span** (`getTimeRecord()` r[4]−r[1]),
> which carried an **every-3rd-cycle over-budget spike** — *not* a GPU problem but
> the normal **audio-clock sync wait**: the engine runs faster than realtime, so
> periodically a cycle blocks on `pushCycleAudioToDriver` to re-sync with the audio
> clock (back-pressure). To show GPU compute cost free of that host wait, the series
> now plots **`getGpuProfilingData()` `add_ms`** (the addKernel/main-synthesis DEVICE
> time, CUDA-event measured). Measured proof: across the every-3rd cadence the full
> span is over-budget 7–20% by phase while `add_ms` is **0% over-budget every phase**
> (flat ~537us = 40% of the 1333us budget) — the periodicity lives entirely in the
> host sync wait, not the kernel. The full-cycle host span is still reported as
> **context text** (`Full-cycle host span (us)`).

What it adds when `include_profiling=True` **and** `mode="online"`:

| Output | Source | Shape |
|--------|--------|-------|
| **"Add-kernel device time (us)"** chart | `pianoid.getGpuProfilingData()` per-cycle `[cycle, parameter_ms, gauss_ms, add_ms, filter_ms]` → `add_ms` (index 3) ×1000 = us | one line series, **no AudioPlayer** (it is a timing series, not audio) |
| **Budget markLine** | `samples_per_cycle × 1e6 / sample_rate` (1333.33us at 64@48k) | `render_hints.threshold` (red dashed line) |
| **Over-budget markers** | per-cycle `add_us > budget` | `render_hints.point_styles` — over-budget cycles = red diamond, on-budget = teal circle; `point_meta` carries `{cycle, us, over_budget}` into the tooltip |
| **Underrun + jitter summary** | `pianoid.getCallbackStats()` (`CallbackTimingStats`) + `getTimeRecord()` | `text_fields`: `Underruns` (count / callbacks / %), `Callback interval (us)` (avg/max/std), `Add-kernel device time` (cycles, budget, over-budget %, median/max), `Full-cycle host span (us)` (median/max — host D2H/driver/scheduler overhead, context only) |

**Capture window.** The online branch wraps the playback-capture sleep with
`resetProfiling()` + `startProfiling()` + `resetCallbackStats()` + `initTimeRecord()`
**before** and `stopTimeRecord()` + `stopProfiling()` + `getTimeRecord()` +
`getCallbackStats()` + `getGpuProfilingData()` **after**, so the window spans exactly
the rendered note. The telemetry primitives (incl. `resetProfiling`/`startProfiling`/
`stopProfiling`/`getGpuProfilingData`) are in `_SOUND_TEST_ALLOWED_PIANOID_CALLS` so the
architectural-contract test still passes. A build lacking these methods (or without
`PIANOID_ENABLE_PROFILING`) degrades gracefully (a `Profiling note` text field, no
chart) rather than failing the whole render.

**Underrun-marker semantics (honest mapping).** `getCallbackStats()` exposes only
a **cumulative** `underrunCount` over the window, not a per-cycle underrun
timeline (no such binding exists). So the per-cycle MARKERS are the **over-budget
cycles** (now over-budget on the pure `add_ms` kernel series), while the total
underrun count + callback jitter go to `text_fields`. A precise per-cycle underrun
timeline would need a new C++ ring-of-timestamps binding (out of scope).

**GPU-vs-host attribution (dev-underrun2 rate-sweep, 2026-06-19).** A realtime
note-on rate sweep (idle/2/8/20/40 per sec, IversPond 128modes, SDL3, 30s each)
established that the true GPU kernel device time (`add_ms`) is **FLAT at ~537us
(0.1% spread) regardless of note rate** and never approaches the 1333us budget,
while the over-budget cycles (~13%) and rare real underruns (<1.4%, no rate trend)
are host-side (the every-3rd sync wait + occasional scheduler/callback jitter,
`cb_max` ~11ms). Verdict: under load the bottleneck is **system hiccups, not GPU
slowdown**. This is precisely why the chart plots `add_ms` — it isolates the flat
GPU cost from the host sync wait.

**Online-only.** Offline mode has no live cycle/underrun data, so
`include_profiling` in offline mode emits only a `Profiling note` (no chart).
Covered by `tests/unit/test_sound_test_profiling.py` (16 tests: pure-helper math
for both full-cycle span and `add_ms` extraction, chart/threshold/marker structure,
online population + telemetry call-order, profiling-off no-op, graceful-degrade,
offline note-only).

### Full-cycle + in-cycle checkpoint decomposition (dev-soundd, 2026-06-22)

dev-profchart/dev-underrun2 established that the per-cycle over-budget time is
**NOT** the GPU kernel (`add_ms` is flat ~537us) but the **host audio-clock sync
wait**. dev-soundd **instruments that wait directly** so where the non-kernel
delay lives is *visible*, not inferred. New C++ checkpoints in the cycle
(`Pianoid_synthesis.cu` `runCycle`/`pushCycleAudioToDriver`, exposed via the
existing `getTimeRecord()`):

| Checkpoint | Where | Span it bounds |
|---|---|---|
| cp0 | cycle start | — |
| cp1 | post synthesis kernel | **kernel** cp0→cp1 |
| cp2 | audio output prepared (FIR + channel expansion done) | **audio-prep / FIR secondary kernels** cp1→cp2 |
| cp3 | post `pushSamples()` (the blocking driver push returned) | **SYNC WAIT** cp2→cp3 — the host audio-clock back-pressure (`CircularBuffer::produce` `canProduce.wait`), THE non-kernel delay |
| cp4 | audio-stage end (host record/append tail) | **host-tail** cp3→cp4 |
| cp5 (LAST) | cycle end | **full cycle** cp0→cp5 (incl. the sync wait) |

When `include_profiling=True` **and** `mode="online"`, the builder
(`_sound_test_build_profiling_charts`) now also adds:

| Output | Source | Shape |
|--------|--------|-------|
| **"Full cycle incl. sync (us)"** chart | `getTimeRecord()` cp0→cp5 per cycle | line + budget markLine + per-cycle over-budget markers (red diamond) |
| **"Driver-push sync wait (us)"** chart | `getTimeRecord()` cp2→cp3 per cycle | line (the isolated blocking wait, on its own axis) |
| **"Cycle checkpoint breakdown (us, median)"** | per-span medians | `text_fields` — kernel / audio-prep / SYNC-WAIT / host-tail / FULL |
| **"Non-kernel delay attribution"** | `sync / full` share | `text_fields` — one-line verdict naming the sync wait + its % of the full cycle |

The decomposition helper `_sound_test_checkpoint_spans_us` reads spans by
position from the 7-entry online row (`[offset, cp0..cp5]`); shorter rows
(offline / pre-soundd builds) yield only the depth-robust kernel + full spans
(cp2/cp3 are never guessed from an ambiguous position — profiling is online-only
in practice). The legacy `_sound_test_full_cycle_times_us` now reads the LAST
checkpoint minus cp0 (depth-robust across instrumentation depths). Covered by
`tests/unit/test_sound_test_d2.py` (`TestCheckpointSpans`).

### Spectrum chart + align-then-zoom-sync (dev-soundd D2, 2026-06-22)

Two opt-in toggles, both **default off → byte-identical** response when absent:

- **`include_spectrum`** — appends one single-sided FFT-magnitude chart
  (Hann-windowed, `_sound_test_spectrum`) per captured time-domain source.
  x-axis = frequency (Hz), `sync_group:"freq"` (excluded from the time zoom-sync,
  no AudioPlayer).
- **`include_time_axis`** (align-then-zoom-sync, design
  `d2c-align-zoom-design.md`) — emits a **real ms x-axis** (`x_axis_values` via
  `_sound_test_time_axis_ms`) for the time-domain charts and tags them
  `sync_group:"time"`. Engine taps are hard-timed at offset 0; the **mic** is
  aligned to the engine reference tap (`kernel ch0 → fir ch0 → sint ch0`) by
  **envelope cross-correlation** (`_sound_test_estimate_mic_delay`) — integer-
  sample delay, honest negative-ms pre-roll, degrades to unshifted + a warning
  below a 0.30 confidence floor. The frontend (`chartOption.js` /
  `newWindowChart.jsx`) switches **only** `sync_group:"time"` charts to a VALUE
  x-axis (plot `[t_ms, y]`) and `echarts.connect("time")`s them so a zoom on one
  mirrors to the others; spectrum (freq) and profiling (cycle) are excluded.
  Covered by `tests/unit/test_sound_test_d2.py` (delay-estimation on synthetic
  signals with a KNOWN injected delay, spectrum, time-axis) +
  `src/utils/__tests__/chartOption.test.js` (the gated value-axis + byte-identical
  guards). **Live mic-loopback alignment is folded into the user's combined
  audio_on test** (the dev box crashes the FE audio_on path).

> **D2c open-question defaults adopted** (design §Open questions; flagged for
> user confirmation): Q1 honest negative-ms pre-roll (mic shown at its true
> −delay, not trimmed); Q2 sub-sample fractional alignment OUT of scope
> (integer-sample at 48k); Q3 reference tap = kernel→fir→sint ch0; Q4 confidence
> floor = 0.30 (a placeholder — needs a measured floor from a real loopback).

### Saving the displayed result (dev-soundd D2 (a), 2026-06-22)

`newWindowChart.jsx` renders **Save JSON** / **Save CSV** buttons above any
chart whose response carries numeric `data`. Both are built client-side from the
already-fetched response (no extra backend call): JSON = full fidelity
(text_fields + render_hints, minus the bulky base64 audio); CSV = the 1-D numeric
chart columns (one column per entry) for an external spreadsheet/plot.

---

## Chart-native audio playback (dev-chartplay, 2026-05-31)

Any chart whose REST response carries a non-null `audio_data[i]` entry renders an
inline **AudioPlayer** widget (`PianoidTunner/src/components/newWindowChart.jsx`)
directly above that chart — play/pause toggle + a click-to-seek progress bar with
`m:ss` elapsed/total readouts. It is per-chart-entry, so a multi-source
`sound_test` response (kernel ch0, kernel ch1, sint ch0, …) gets one independent
player per entry; the decode→play helper (`base64WavToBlobUrl` / `playBase64Wav`,
revokes the blob URL on `ended`/`error`) is extracted into
`src/utils/audioPlayback.js` and reused by the offline "Play All" sweep.

The base64 WAV is attached backend-side by `ChartArray.create_audio_to_chart('all', sample_rate=…)`,
which calls `ChartData.create_audio()` per chart. The audio-producing chart
functions that wire it are: `sound_function`, `filter_test_function`,
`mode_test_function`, `play_note_offline_chart_function`,
`online_midi_playback_chart_function`, and `sound_test_function`. The attachment
is purely additive — callers that ignore `audio_data` are unaffected, and a chart
with `audio_data[i] === null` renders no player for that entry.

---

## Optional `render_hints` — richer chart rendering (dev-ratiochart, 2026-05-24)

The frontend chart renderer (`newWindowChart.jsx`, via `src/utils/chartOption.js`)
historically rendered every chart's numeric arrays with one rigid ECharts option:
x-axis = array index `0..N-1`, a single `type:"line"` series, value y-axis,
`dataZoom` inside+slider, default tooltip. That is still the default.

A chart function MAY now opt into richer rendering by including an optional
top-level **`render_hints`** key in its response — a list **parallel to `data`**
(one entry per chart; entry `null`/absent = default rendering for that chart).
The renderer's `buildChartOption()` reads it. **Every field is optional and
additive; a chart that omits `render_hints` renders byte-identical to before.**
This is the contract a backend chart function emits to drive the enriched view
(introduced for the CFL stability ratio-vs-pitch chart).

`render_hints[i]` fields:

| Field | Type | Effect |
|-------|------|--------|
| `x_axis_values` | `any[]` | Explicit x-axis category labels (e.g. pitch numbers / note names) — replaces the default `0..N-1` index axis. Length should match the chart's data array. |
| `x_axis_name` | string | X-axis title. |
| `y_axis_name` | string | Y-axis title. |
| `series_type` | string | `"line"` (default) or `"scatter"`. |
| `threshold` | `{value:number, label?:string, color?:string}` | Renders a horizontal **markLine** at `value` (dashed, silent, labelled). Used for the CFL stability limit (`value = cfl_limit = 1`). |
| `thresholds` | `Array<{value:number, label?:string, color?:string}>` | **Additive** — renders one or more *extra* horizontal markLines alongside the single `threshold`, each independently styled/labelled. Used for the CFL ratio chart's `CFL_MARGIN` headroom reference line. A renderer build without this support ignores the array and still shows the single `threshold` (graceful degrade). Added by `feature/cfl-stability-chart` (`5e5d546`, Part 1 extension). |
| `point_styles` | `Array<{color?:string, symbol?:string}>` | Per-point styling. **Length MUST equal the data array** (a mismatch is ignored and the chart falls back to a uniform series — fail-safe, never blanks). Supplying a `symbol` gives a **non-colour cue** alongside `color` so stable/unstable points are distinguishable without relying on colour (accessibility). |
| `point_meta` | `Array<object>` | Per-point metadata merged into the tooltip (e.g. `{stable:true}`). |
| `tooltip_fields` | `string[]` | Ordered `point_meta` keys to surface in the tooltip; defaults to all keys. |

When `point_meta` or `x_axis_values` is present, the renderer attaches a custom
`tooltip` (axis-trigger) showing the x label + value + selected meta fields;
otherwise ECharts' built-in tooltip is used (legacy behaviour, unchanged).

**Example response fragment** (one chart, CFL stability ratio vs pitch):

```json
{
  "data": [[0.018, 0.034, 0.86, 0.041]],
  "chart_headers": ["CFL Courant Ratio"],
  "render_hints": [{
    "x_axis_values": ["A0", "A#0", "B0", "C1"],
    "x_axis_name": "Pitch", "y_axis_name": "CFL ratio (Courant)",
    "series_type": "scatter",
    "threshold": {"value": 1.0, "label": "CFL limit (1)", "color": "#ef5350"},
    "thresholds": [{"value": 0.8, "label": "CFL margin (0.8)", "color": "#ffa726"}],
    "point_styles": [
      {"color": "#26a69a", "symbol": "circle"},
      {"color": "#26a69a", "symbol": "circle"},
      {"color": "#ef5350", "symbol": "diamond"},
      {"color": "#26a69a", "symbol": "circle"}
    ],
    "point_meta": [
      {"courant": 0.018, "decision": "allowed"},
      {"courant": 0.034, "decision": "allowed"},
      {"courant": 0.86, "decision": "rejected"},
      {"courant": 0.041, "decision": "allowed"}
    ],
    "tooltip_fields": ["courant", "decision"]
  }]
}
```

**Part 2 — implemented (dev-7032, 2026-05-30; revised same day).** The backend
`chartFunctions.py` function that emits this is `cfl_ratio_function` (registered as
the `cfl_ratio` chart). It is PURE-PYTHON / host-side: per pitch it calls
`pianoid.param_manager._pitch_upload_amp(pitch)` (the v2 host closed-form, no GPU /
no debug build) and builds the chart array from the per-pitch worst-string
**Courant number** (`coeff_tension − 8·coeff_bending`). **Revision:** the first
version plotted `max|g|`, which is degenerate-flat at `1.0` for every stable string
→ the user saw a flat line; the chart was switched to the Courant number, which
varies per pitch and shows each pitch's headroom. The redline (`CFL_LIMIT = 1.0`)
is the Courant = 1 stability edge; the `CFL_MARGIN` line (additive `thresholds`
array, read `cfl_stability.CFL_MARGIN` **live**) is the gate's reject threshold;
per-point colour is the gate's actual `is_stable_with_margin` decision. Covered by
`tests/unit/test_cfl_ratio_chart.py` (backend, mocked `param_manager`, 13/13) +
`docs/development/diagnostics/dev-7032-cfl-courant-varies.py` (real-preset proof the
Courant array varies, pure-Python) + the renderer's `src/utils/__tests__/chartOption.test.js`
(frontend, 16/16). Backend on PianoidCore `feature/cfl-test-on-p1fix`; the
renderer's `thresholds` extension on PianoidTunner `feature/cfl-stability-chart`
(`5e5d546`).

> **Data-model note (why Courant, not |g|):** `max|g|` (the von-Neumann
> amplification) is degenerate-FLAT at exactly `1.0` for every stable string and
> only jumps past 1 when unstable (`cfl_stability.py` `CFL_MARGIN` docstring) — so a
> `max|g|` chart is a useless flat line. The **Courant number** (`coeff_tension −
> 8·coeff_bending`) varies per pitch and is the quantity that resolves each pitch's
> real headroom below the edge, and it is exactly what `CFL_MARGIN` thresholds.
> Hence the chart plots the Courant number. The redline (1.0) is the Courant
> stability edge; a point is coloured rejected when its worst-string Courant reaches
> `CFL_MARGIN` (or, for the lower/bending edge the Courant doesn't encode, when
> `max|g| > 1`).
