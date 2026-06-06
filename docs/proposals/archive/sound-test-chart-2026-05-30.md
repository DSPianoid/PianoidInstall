# Sound Test diagnostic chart — design proposal

- **Author:** dev-stest-4a7c
- **Date:** 2026-05-30
- **Status:** IMPLEMENTED + MERGED at scope **S3** (all four sources) — shipped via dev-stest-4a7c (PianoidCore merge `b13ea4a`): `sound_test` chart in `chartFunctions.py` (registered in `chart_config.json`, dispatchable), multi-source kernel/FIR/Sint/mic via `PanoidResult` (incl. the rebuilt post-volume `dev_soundInt` readback hook `load_sint_audio_from_pianoid`), multi-channel offline writer, unit test `test_sound_test_chart.py`. The S1/S2/S3 scope question is resolved (S3 shipped). Only deferred item: the optional custom `SoundTestParamsPane.jsx` (auto-rendered pane in use instead). Header below ("awaiting Scope direction") is stale. Archived 2026-06-06.
- **Related docs:**
  - `docs/modules/pianoid-middleware/CHART_SYSTEM.md` (chart registration + `render_hints`)
  - `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` (signal pipeline, FIR placement, per-sample write)
  - `docs/modules/pianoid-cuda/DEBUG_DATA.md` (extraction API, PianoidResult)
  - `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md` (Online vs Offline regime split)
  - `docs/modules/pianoid-cuda/AUDIO_DRIVERS.md` (pipeline diagram)
  - `docs/modules/pianoid-middleware/REST_API.md` (`POST /get_chart_test`, `POST /play_keyboard`)
  - `docs/development/TESTING.md` (strict A1 audio_off vs audio_on)
- **Related prior work:** dev-soundint-live session log at `docs/development/logs/dev-soundint-live-2026-05-29-153254.md` (full Phase A design + measurement record for a post-volume `dev_soundInt` readback hook). **The hook code itself is GONE** — the referenced stash (`stash@{0}=26799bf`) and feature branch (`feature/soundint-readback`) have been pruned (verified 2026-05-30: `git stash list` shows no soundint entry; commit `26799bf` is not reachable via `git cat-file -t`; no `feature/soundint-readback` in `git branch -a`). The design intent — per-output-channel ring mirror of `dev_soundInt`, exposed via pybind + REST chart, with the known layout bug (uninitialised-tail rail) measured and refuted — is reconstructable from the archived log. **Treat §5.3 / §6 as a re-derivation guide, not a cherry-pick recipe.**

---

## 1. One-paragraph summary

A new chart type — `sound_test` — registered through the existing standard chart mechanism (`chart_config.json` + `chartFunctions.py` + `POST /get_chart_test`). Parameters: a play-spec (single pitch OR chord OR sequence), duration, channel selection, and one-or-more selectable data sources (synth kernel-output, synth post-FIR, synth Sint, recorded mic). The backend chart function triggers an offline render (or, for the mic source, an online render with mic capture) of the play-spec, extracts the requested sources from `PianoidResult` plus engine getters, and returns one chart per (source × channel) overlaid on the same time axis using the existing `render_hints` mechanism. Frontend uses the existing `newWindowChart.jsx` renderer + a new parameter pane for the play-spec. No new REST endpoint required.

---

## 2. User-facing parameter schema

The chart is registered as a single `ChartType` with these `ChartParameter` entries (exact JSON form follows the `note_playback` entry in `chart_config.json`):

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `play_kind` | choice | `"note"` | One of: `note`, `chord`, `sequence`. Determines how `pitches` / `velocities` / `note_durations_ms` are interpreted. |
| `pitches` | string | `"60"` | Comma-separated MIDI integers. `note` → first element only. `chord` → all played simultaneously. `sequence` → played in order. |
| `velocities` | string | `"100"` | Comma-separated MIDI velocities. If shorter than `pitches`, last value is broadcast. |
| `note_durations_ms` | string | `"500"` | Per-note hold-time (NOTE_ON → NOTE_OFF). Broadcast like `velocities`. **Sequence-only**: per-step inter-onset interval is `note_durations_ms[i]` (back-to-back; no gap). |
| `tail_ms` | number | `2000` | Capture tail after the last NOTE_OFF, to record decay. |
| `display_length_ms` | number | `0` | `0` → display full capture (synth render + tail). `>0` → display window starts at first NOTE_ON, runs for this many ms. |
| `channels` | string | `"all"` | `"all"` OR comma-separated channel indices (0-based). Channels not present in the active preset are silently dropped. |
| `sources` | string | `"sint"` | Comma-separated subset of `kernel,fir,sint,mic`. Order = legend order. Selecting `mic` requires `audio_driver_type ≠ 0` (audio_on). |
| `include_full_result` | boolean | `false` | Mirrors `note_playback`'s flag — opt-in dump of the full `PianoidResult` for test/CI callers. |

**Why "string with commas" for the multi-value fields:** `ChartParameter` types are limited to `string`, `number`, `int`, `float`, `boolean`, `choice` (no array). The existing `online_midi_chart` / `play_keyboard` etc. all use this comma-string pattern. The backend parses with a single helper (`_parse_int_csv` / `_parse_str_csv`) that already exists in nearby chart functions.

**Why a single `sources` parameter, not 4 booleans:** the chart returns one chart array per selected (source × channel) and the front renders them as a legend-overlayed multi-series chart. Keeping it as a single CSV string makes the selection order explicit (= rendering / legend order) and keeps the parameter pane compact.

---

## 3. REST / WS API surface

**No new REST endpoint.** The chart is invoked through the standard:

```
POST /get_chart_test
{
  "chartType": "sound_test",
  "play_kind": "note",
  "pitches": "60",
  "velocities": "100",
  "note_durations_ms": "500",
  "tail_ms": 2000,
  "display_length_ms": 0,
  "channels": "all",
  "sources": "kernel,fir,sint",
  "include_full_result": false
}
```

Response uses the standard chart envelope already documented in CHART_SYSTEM.md "Optional `render_hints`":

```
200 OK
{
  "data": [[…ch0/kernel…], […ch1/kernel…], […ch0/fir…], …],
  "chart_headers": ["Kernel ch0", "Kernel ch1", "Post-FIR ch0", …],
  "general_header": "Sound Test: Note C4 (60)",
  "text_fields": {
    "Cycles rendered": "200",
    "Sample rate": "48000 Hz",
    "Sources": "kernel, fir, sint",
    "Channels": "0, 1, 2, 3",
    "Captured tail": "2000 ms",
    "Mic peak": "0.041",
    "Mic RMS":  "0.012"
  },
  "audio_data": [null, …, "<base64 WAV>"],
  "render_hints": [
    { "x_axis_name": "time (ms)", "y_axis_name": "amplitude" },
    …
  ]
}
```

This reuses the dev-ratiochart `render_hints` channel: each chart entry gets a uniform millisecond x-axis. The frontend renderer already handles per-chart `x_axis_values` / `y_axis_name`.

**No new WebSocket events.** The chart is one-shot. Long capture (sequence + long tail) blocks the HTTP call for at most `total_play_ms + tail_ms` (same blocking pattern `/play_keyboard capture_mic` uses today — capped at ~10 s).

---

## 4. Backend chart function (pseudocode)

File: `PianoidCore/pianoid_middleware/chartFunctions.py`. Adds one new function and reuses the existing helpers.

```python
def sound_test_function(pianoid, **kwargs):
    """
    Single diagnostic chart that overlays one or more of:
      - kernel  — dev_soundFloat   (pre-FIR, pre-volume float)
      - fir     — dev_filteredSoundFloat (post-FIR, post-volume float — Online only)
      - sint    — dev_soundInt     (post-volume Sint32 — what the driver receives)
      - mic     — startMicCapture/stopMicCapture (audio_on only)
    on a shared time axis, per selected channel.
    """
    play_kind, pitches, velocities, note_durations_ms, tail_ms, \
    display_length_ms, channels_csv, sources_csv, include_full_result \
        = _extract_sound_test_kwargs(kwargs)

    sources       = _parse_sources(sources_csv)        # subset of {kernel,fir,sint,mic}
    sample_rate   = pianoid.mp.sample_rate()
    samples_pc    = pianoid.mp.mode_iteration
    num_channels  = pianoid.mp.num_channels
    channels      = _resolve_channels(channels_csv, num_channels)
    event_queue   = _build_event_queue(play_kind, pitches, velocities,
                                        note_durations_ms, samples_pc, sample_rate)
    total_cycles  = _total_cycles(event_queue, tail_ms, samples_pc, sample_rate)

    charts       = ChartArray()
    text_fields  = {}
    extra        = {}

    # Branch on whether mic is requested:
    if "mic" in sources:
        # Online path: drives the audio driver. Mic capture runs in parallel.
        _run_online_with_mic(pianoid, event_queue, tail_ms, total_cycles,
                              capture_kernel="kernel" in sources,
                              capture_fir="fir" in sources,
                              capture_sint="sint" in sources)
    else:
        # Audio_off path: deterministic offline render. Reuses
        # _stop_online_engine + runOfflinePlayback + _load_offline_sound_to_result
        # AND the new multi-channel + sint-ring extraction (§5).
        _run_offline(pianoid, event_queue, total_cycles,
                      need_kernel="kernel" in sources,
                      need_fir   ="fir"    in sources,
                      need_sint  ="sint"   in sources)

    # Append one ChartData per (source × channel) — order matches sources_csv
    for src in sources:
        for ch in channels:
            data, header = _extract_source_channel(pianoid, src, ch,
                                                    display_length_ms, sample_rate)
            charts.append_chart(header, data)

    # Reuse the existing audio-attach helper for the first available source:
    charts.create_audio_to_chart('all', sample_rate=sample_rate)

    # Build render_hints — uniform time-axis label for every chart
    render_hints = [
        { "x_axis_name": "time (ms)", "y_axis_name": _y_axis_for(src) }
        for src in sources for ch in channels
    ]

    text_fields.update({
        "Cycles rendered": str(total_cycles),
        "Sample rate":     f"{sample_rate} Hz",
        "Sources":         ", ".join(sources),
        "Channels":        ", ".join(map(str, channels)),
    })

    if include_full_result:
        extra["pianoid_result"] = pianoid.result.to_dict()
        return charts, "Sound Test", text_fields, extra
    return charts, "Sound Test", text_fields, {"render_hints": render_hints}
```

The 4-tuple return is already understood by `ChartGenerator.form_response` (precedent: `cfl_ratio_function`).

`_run_offline` is the same pattern as `play_note_offline_chart_function` (resetStringsState → runSynthesisKernel flush → clearRecords → runOfflinePlayback), with the added requirement that the offline engine's `collectAudio` collects ALL channels — see §5.1.

`_run_online_with_mic` is the same pattern as `POST /play_keyboard capture_mic=true` (startMicCapture → schedule_event loop → sleep total → stopMicCapture). For kernel/fir/sint sources in this branch, the read happens AFTER schedule completes via `getRawSoundRecord` (kernel) / `getFilteredSoundRecord` (fir, new — §5.2) / `getRawSoundRecordInt` (sint, from stash — §5.3).

---

## 5. Architecture — ALL chart sources via PianoidResult (Phase A3 redirect, 2026-05-30)

**Per user direction (Phase A3, 2026-05-30, msg 3055): "All result extraction should be routed via PianoidResult, check"**

The chart function MUST NOT call any per-source C++ getter directly (`getRawSoundRecord`, `getRawSoundRecordInt`, `getRawFilteredFloatRecord`, …). It reads each of the four sources as a FIELD on PianoidResult, via uniform accessors that mirror the existing `get_synth_audio()` / `get_mic_audio()` pattern (PanoidResult.py:162-195).

The C++ getters still exist (engine → host transport — `cudaMemcpy` plumbing), but they are called only from PianoidResult's own loader methods. The chart function talks ONLY to PianoidResult.

### 5.0 PianoidResult field plan (the single engine delta, unified)

**Existing PianoidResult fields, audited 2026-05-30T23:20:00Z (PanoidResult.py:18-38):**

| Field | Shape today | Accessor | Writer entry-point | Maps to chart source? |
|---|---|---|---|---|
| `self.sound` | `(num_channels, samples)` after first fetch | `get_synth_audio(channel)` (162-175) + legacy `get_sound(channel)` (71-83) | Online: `get_sound_from_pianoid()` (already multi-channel). Offline: `_load_offline_sound_to_result()` in `chartFunctions.py` (single-channel today, buggy) | **YES — Kernel-output source** (pre-FIR, pre-volume float). Field exists, contract is correct; offline writer needs the A2 fix. |
| `self.records` | `(num_records, num_strings, samples)` | `get_record(record_no, obj_no)` | `get_sound_records_from_pianoid()` | NO — per-string debug records (BRIDGE_FORCE / MODE_STATE / APPLIED_FORCE / MODE_FORCE). Untouched. |
| `self.string_states` | `(2, num_blocks, array_size)` | (direct) | `get_pianoid_state()` | NO. Untouched. |
| `self.output_data` | `(num_states, num_strings, array_size)` | (direct) | `get_output_data_from_pianoid()` | NO. Untouched. |
| `self.parameter_data` | `(num_parameters, num_blocks, array_size)` | `point_parameters(...)` | `get_parameters_data_from_pianoid()` | NO. Untouched. |
| `self.mic_audio` | `None` / `np.ndarray` (mono per `startMicCapture`) | `get_mic_audio()` (177-188) | Caller attaches via `set_mic_audio(buf)` (190-195) — PianoidResult never engages the mic itself | **YES — Recorded mic source**. Field exists, contract is correct; the chart function attaches via the existing `set_mic_audio` setter after `stopMicCapture`. |

**Two NEW PianoidResult fields needed** (one per missing chart source):

| New field | Shape (target, set by writer) | Accessor (new) | Writer entry-point (new) | Maps to chart source |
|---|---|---|---|---|
| `self.post_fir_sound` | `(num_channels, samples)` float | `get_post_fir_audio(channel=0, result_type="ndarray")` — same signature shape as `get_synth_audio` | `load_post_fir_audio_from_pianoid(length=None)` — calls C++ `getRawFilteredFloatRecord()` (NEW, §5.2 below) and reshapes interleaved to `(num_channels, samples)` using the same `swapaxes/reshape` recipe as `get_sound_from_pianoid` (PanoidResult.py:55-57) | **Post-FIR float source** |
| `self.sint_sound` | `(num_channels, samples)` Sint32 (stored as `np.int32` ndarray; the accessor optionally returns a float-cast view for plotting) | `get_sint_audio(channel=0, result_type="ndarray", as_float=False)` — `as_float=True` returns the int / `INT32_MAX` normalisation (same as the existing `getCurrentCycleAudio` convention) | `load_sint_audio_from_pianoid(length=None)` — calls C++ `getRawSoundRecordInt()` (NEW, §5.3 below) and reshapes per-channel | **Sint source** |

**Uniform chart-function read interface (the contract this enforces):**

```python
def sound_test_function(pianoid, **kwargs):
    # Trigger the render (offline or online); see §4
    _run_render(pianoid, ...)

    # Populate the requested PianoidResult fields — fail fast if a source is unavailable
    if "kernel" in sources:
        pianoid.result.get_sound_from_pianoid()        # Online
        # OR _load_offline_sound_to_result(pianoid)    # Offline — fixed per A2
    if "fir"  in sources:
        pianoid.result.load_post_fir_audio_from_pianoid()
    if "sint" in sources:
        pianoid.result.load_sint_audio_from_pianoid()
    if "mic"  in sources:
        pianoid.result.set_mic_audio(mic_buffer)       # caller attaches; existing pattern

    # READ all sources uniformly — never touch raw C++ getters here
    for src in sources:
        for ch in channels:
            data = {
                "kernel": pianoid.result.get_synth_audio,
                "fir":    pianoid.result.get_post_fir_audio,
                "sint":   pianoid.result.get_sint_audio,
                "mic":    lambda channel=ch: pianoid.result.get_mic_audio(),  # mono — channel ignored
            }[src](channel=ch, result_type="ndarray")
            charts.append_chart(_header(src, ch), data[:display_length])
```

**Why this is the right architecture:**
- **Uniform contract.** All four sources speak the same `get_<src>_audio(channel, result_type)` interface. New chart functions don't relearn per-source getters.
- **Tests against PianoidResult, not the engine.** A `MagicMock` PianoidResult with the four fields populated is enough to unit-test `sound_test_function` — no GPU, no `pianoidCuda` import.
- **Caller-attachment pattern preserved for mic.** PianoidResult continues to NOT engage the mic (docstring at PanoidResult.py:35-38 explicitly forbids this); the chart function calls `startMicCapture` / `stopMicCapture` itself and attaches via the existing `set_mic_audio` setter — same pattern `play_keyboard capture_mic=true` and `play_mode_chart_function` already use.
- **Engine-side getters retained but encapsulated.** The C++ side keeps `getRawSoundRecord` / `getRawFilteredFloatRecord` / `getRawSoundRecordInt` as transport primitives; only PianoidResult's loader methods call them. Other future chart functions can use these too without going around PianoidResult.

### 5.0a Phase D doc-follow-up flagged (NOT Phase B scope)

Once the four `load_*_audio_from_pianoid` loaders all use the same reshape recipe, refactor them into a single private helper `PianoidResult._load_per_channel_audio(raw_buffer, num_channels, samples_per_cycle, target_attr)` that all four delegate to. This eliminates duplication and structurally enforces the `(num_channels, samples)` contract. Out of Phase B scope unless user requests it.

---

## 5b. Engine-side transport hooks (writers — called only by PianoidResult loaders)

The three engine-side deltas below are unchanged from the prior proposal in their C++ surface (kernel writes / D2H rings / pybind), but they are now framed as **transport primitives** that feed PianoidResult's loaders. The chart function never sees them.

### 5b.1 Multi-channel offline render — make PianoidResult multi-channel-native (Phase A2 redirect, 2026-05-30)

**Per user direction (Phase A2): the fix lives at the OFFLINE WRITER side, not by extending PianoidResult's schema. PianoidResult is ALREADY multi-channel-native; the offline writer is the buggy actor.**

**PianoidResult schema audit (PanoidResult.py, full read 2026-05-30T22:42:00Z):**
- `self.sound` is a NumPy array. `get_sound_from_pianoid` (Online path, lines 40-58) reshapes raw to `(num_channels, samples)` — **fully multi-channel today**.
- `get_sound(channel)` (line 71) indexes `self.sound[channel, :]`; `channel=-1` returns the full `(num_channels, samples)` 2-D array.
- `save_all_channels_to_wav` (line 256) iterates `range(len(self.sound))` — assumes multi-channel.
- Constructor: `self.sound = np.zeros(self.length)` (a 1-D placeholder that is REPLACED on first fetch).
- **Schema is multi-channel-native; no extension needed.** The defect is purely that the OFFLINE writer leaves it as channel-0-only.

**Where the offline writer drops non-ch0 (the writer chain, top-down):**
1. `MainKernel.cu:512-513` writes `dev_soundFloat[sampleIndex]` for ALL channels per cycle (the full `(num_channels, samplesInCycle)` region). ✓ engine is correct.
2. `Pianoid::getCurrentCycleAudio()` (`Pianoid_synthesis.cu:113-145`) copies only `mode_iteration` floats (`= samples_per_cycle × 1 channel`) from `dev_soundFloat`. ✗ drops channels 1..N.
3. `OfflinePlaybackEngine::collectAudio()` (`OfflinePlaybackEngine.cu:272-288`) calls `getCurrentCycleAudio()` and appends into `recorded_audio_` (sized `total_cycles × samples_per_cycle`, single-channel). ✗ both the read AND the storage assume 1-channel.
4. `Pianoid::runOfflinePlayback` (`Pianoid.cu:1022`) copies `engine.getRecordedAudio()` into `last_recorded_audio_`. ✗ preserves the 1-channel layout.
5. `_load_offline_sound_to_result` (`chartFunctions.py:39-56`) places the flat buffer at `pianoid.result.sound[0]` and leaves other channels zero. ✗ doesn't even attempt a reshape.

**The Online path proves PianoidResult's contract (the target the offline writer must meet):**
- `Pianoid::appendCycleAudioToHostBuffer` (`Pianoid_synthesis.cu:609`) copies the full `mode_iteration * num_channels` extent.
- `getRawSoundRecord()` returns the full interleaved buffer.
- `PianoidResult.get_sound_from_pianoid` (PanoidResult.py:42-58) reshapes to `(num_channels, samples)` and assigns to `self.sound`.
- **The offline writer must converge to the same `result.sound.shape == (num_channels, samples)` contract.**

**Determination: WRITER-FIX-ONLY** (no schema extension to PianoidResult — it's already correct).

**Required changes (the writer chain):**

| Layer | Current behaviour | Fix |
|---|---|---|
| `Pianoid::getCurrentCycleAudio()` | Copies `mode_iteration` floats (ch0 only) from `dev_soundFloat`. | Copy the full `mode_iteration × num_channels` extent. Return `(num_channels × samples_per_cycle)` floats per cycle, interleaved-per-channel (matches the kernel layout). Signature unchanged (still `std::vector<float>`). |
| `OfflinePlaybackEngine::recorded_audio_` (Offline.h:38) | Sized `total_samples = total_cycles × samples_per_cycle`. | Size `total_cycles × samples_per_cycle × num_channels`. |
| `OfflinePlaybackEngine::collectAudio` | Appends `samples_per_cycle` floats per cycle. | Appends `samples_per_cycle × num_channels` floats per cycle. |
| `Pianoid::runOfflinePlayback` → `last_recorded_audio_` | `std::vector<float>`. | No schema change. Now carries the multi-channel buffer transparently. |
| Pybind binding (`AddArraysWithCUDA.cpp`) | Returns flat `std::vector<float>`. | No change. Consumer reshapes. |
| `_load_offline_sound_to_result` (`chartFunctions.py:39`) | Deposits at `result.sound[0]` (lives in chartFunctions; chart fn calls it directly). | **Move onto PianoidResult as `load_offline_sound_from_pianoid()` method** (Phase A3 directive — chart fn must not own this loader). New PianoidResult method calls `self.p.getRecordedAudio()` and applies the SAME reshape `get_sound_from_pianoid` uses (PanoidResult.py:55-57): `np.asarray(raw).reshape(num_cycles, num_channels, samples_per_cycle).swapaxes(0,1).reshape(num_channels, -1)` → assigns to `self.sound`. After this, `result.sound.shape == (num_channels, samples)` in BOTH offline and online; chart fn calls `result.load_offline_sound_from_pianoid()` after `runOfflinePlayback`, then reads via the standard `result.get_synth_audio(channel=N)` accessor. The old `_load_offline_sound_to_result` in chartFunctions becomes a thin one-line shim or is deleted outright. |

**Why this honours "multi-channel native to PianoidResult":**
- Every caller of `pianoid.result.get_sound(channel=N)` works for any N — same contract in audio_on AND audio_off.
- The chart function does NOT special-case offline vs online — it does `pianoid.result.get_sound(channel=N)` after either `get_sound_from_pianoid()` or the fixed `_load_offline_sound_to_result()`. Both populate `result.sound` to the same `(num_channels, samples)` shape.
- `_load_offline_sound_to_result` becomes a near-duplicate of `get_sound_from_pianoid`'s reshape logic. **Phase D doc-follow-up (NOT Phase B):** consider folding both into a single PianoidResult method (e.g. `load_from_buffer(raw, kind="online"|"offline")`) so the contract is enforced structurally, not by convention. Flagged but out of Phase B scope unless the user requests it.

**Cost:** ~30 LOC C++ + ~5 LOC Python (unchanged from the original estimate). Files: `Pianoid_synthesis.cu`, `OfflinePlaybackEngine.h`, `OfflinePlaybackEngine.cu`, `chartFunctions.py`. Triggers `--heavy --release` build.

**Doc-gap closed by this (per user direction #4):** the corrected behaviour is "offline path produces `result.sound` of shape `(num_channels, samples)` — identical to online". DEBUG_DATA.md's "Data Flow by Consumer" + the PianoidResult Data Members table will be updated to drop any wording that implies offline is single-channel. The "Stored vs effective" gap moves from a known-defect note to a correct-behaviour description. The `_load_offline_sound_to_result` docstring is updated to describe the new reshape.

### 5b.2 Post-FIR float readback hook — feeds `PianoidResult.post_fir_sound`

**Chart-fn contract (per Phase A3 directive):** chart reads `result.get_post_fir_audio(channel=N)`. The C++ getter below is called only by `PianoidResult.load_post_fir_audio_from_pianoid()`, never by the chart function.

**Current state (measured + doc-confirmed):**
- `dev_filteredSoundFloat` exists (MEMORY_MANAGEMENT.md:186, `OUTPUT` category, always allocated alongside `dev_filteredSound` Sint32).
- The FIR convolution kernel writes this whenever `FIRfilterON == true`; it lives in `pushCycleAudioToDriver()` (PLAYBACK_SYSTEM.md:205), so it ONLY runs in the Online regime.
- There is NO C++ getter for `dev_filteredSoundFloat`. The post-FIR signal is unobservable today.

**Transport-layer change (C++ side, called only by PianoidResult's loader):**
- Add a `rawFilteredFloatBuffer` (same 5-second host ring pattern as `rawSoundBuffer`), populated by a new `appendCycleFilteredFloatToHostBuffer()` invoked from `pushCycleAudioToDriver()` AFTER the FIR kernel writes `dev_filteredSoundFloat`. Pattern is a verbatim mirror of `appendCycleAudioToHostBuffer`.
- Add `getRawFilteredFloatRecord()` host getter + pybind binding.
- Files: `Pianoid.cuh` (members), `Pianoid.cu` (resize), `Pianoid_synthesis.cu` (append call site), `Pianoid_debug.cu` (getter + clear), `AddArraysWithCUDA.cpp` (pybind).
- Cost: ~40 LOC C++. Triggers `--heavy --release` build.

**PianoidResult-layer change (Python side, the chart-fn entry point):**
- Add `self.post_fir_sound` field to `__init__`.
- Add `load_post_fir_audio_from_pianoid(length=None)` method that calls `self.p.getRawFilteredFloatRecord()` and reshapes to `(num_channels, samples)` using the same recipe as `get_sound_from_pianoid` (PanoidResult.py:55-57).
- Add `get_post_fir_audio(channel=0, result_type="ndarray")` accessor mirroring `get_synth_audio` (PanoidResult.py:162-175).
- Files: `PanoidResult.py` (~30 LOC).

**Constraint flagged:** the `fir` source therefore requires (a) FIR enabled, (b) **Online regime** (FIR is only invoked from `pushCycleAudioToDriver`). In the Offline regime `dev_filteredSoundFloat` is never written. If `fir` is requested in audio_off mode, the chart's mode-routing layer (NOT the PianoidResult layer) handles the constraint: returns a single empty array + a `text_fields` warning so the chart still renders the other selected sources. PianoidResult's `load_post_fir_audio_from_pianoid` documents this in its docstring but returns empty cleanly when the ring is empty — no exception.

### 5b.3 Post-volume Sint readback hook — feeds `PianoidResult.sint_sound`

**Chart-fn contract (per Phase A3 directive):** chart reads `result.get_sint_audio(channel=N, as_float=False|True)`. The C++ getter below is called only by `PianoidResult.load_sint_audio_from_pianoid()`, never by the chart function.

**Current state:**
- `dev_soundInt[sampleIndex] = Sint32(output * main_volume_coefficient)` per `MainKernel.cu:492` — POST-volume. Always-allocated `OUTPUT` category (debug-data.md:54).
- No getter today. dev-soundint-live (2026-05-29) designed and partially built one on `feature/soundint-readback` / `stash@{0} = 26799bf`, but **that branch + stash were pruned at some point before 2026-05-30** (verified absent in `git stash list` and `git branch -a`). The CODE is gone; only the design record (`docs/development/logs/dev-soundint-live-2026-05-29-153254.md`) survives.

**Transport-layer change (C++ side, re-derived from scratch — called only by PianoidResult's loader):**

The previous session's code is unreachable, so this phase re-implements the hook from the documented design. The pattern is a verbatim mirror of the existing `rawSoundBuffer` machinery, swapping `float` for `Sint32`:

| Edit site | What lands | Mirror of existing code |
|---|---|---|
| `Pianoid.cuh` | + `std::vector<Sint32> rawSoundIntBuffer; size_t rawSoundIntWritePos{0}; size_t rawSoundIntCapacity{0};` | `rawSoundBuffer` family (Pianoid.cuh:134-136) |
| `Pianoid.cu` ctor | + `rawSoundIntCapacity = 5 * sample_rate * num_channels * samplesInCycle / mode_iteration;` (see Sizing below) + `resize(capacity, 0)` + `rawSoundIntWritePos = 0;` | Pianoid.cu:96-99 |
| `Pianoid_synthesis.cu` | + `appendCycleSoundIntToHostBuffer()` that per-channel copies `samplesInCycle` Sint32 entries from `dev_soundInt + ch*mode_iteration` into the ring (handles wrap, exactly like the float path) + call site in `runCycle` Online branch alongside `appendCycleAudioToHostBuffer()` | `appendCycleAudioToHostBuffer` at Pianoid_synthesis.cu:609 |
| `Pianoid_debug.cu` | + `getRawSoundRecordInt()` returns oldest-to-newest unwrapped copy + extend `clearRecords()` to zero `rawSoundIntBuffer` + reset `rawSoundIntWritePos` | `getRawSoundRecord` + `clearRecords` (Pianoid_debug.cu:73, :207) |
| `AddArraysWithCUDA.cpp` | + pybind binding for `getRawSoundRecordInt` | `getRawSoundRecord` binding at :790 |

**Sizing the ring correctly the first time.** The float ring is `5*sample_rate*num_channels` because the float append copies `mode_iteration*num_channels` floats per cycle and the engine produces one cycle every `samplesInCycle*1000/sample_rate` ms. The Sint append (per the layout-bug-fix below) copies only `samplesInCycle*num_channels` Sint32 per cycle, so the equivalent 5-second ring is `5*sample_rate*num_channels*samplesInCycle/mode_iteration` Sint32 entries — typically smaller because `samplesInCycle ≤ mode_iteration` (samplesInCycle is the per-channel valid extent, mode_iteration is the per-channel allocated extent).

**Layout-bug avoidance (the lesson from dev-soundint-live's measurement).** The previous attempt copied `mode_iteration*num_channels` Sint32 — but the kernel writes only `[0, samplesInCycle)` per channel inside a `mode_iteration`-sized buffer; the tail is uninitialised Sint32 garbage and reads as ±INT_MAX (rails). **This re-implementation must therefore use per-channel `samplesInCycle` copies from the start** (NOT the `mode_iteration*num_channels` chunk the previous attempt used). Concretely the append loop is:

```cpp
const int spc      = cycle_parameters_host[3];   // samplesInCycle
const int miter    = init_params_.mode_iteration;
const int nch      = init_params_.num_channels;
const size_t chunk = spc * nch;                  // Sint32 entries copied per cycle
for (int ch = 0; ch < nch; ++ch) {
    const size_t dst = (rawSoundIntWritePos + ch * spc) % rawSoundIntCapacity;
    const size_t spaceToEnd = rawSoundIntCapacity - dst;
    cudaMemcpy(rawSoundIntBuffer.data() + dst,
               dev_soundInt + ch * miter,
               std::min<size_t>(spc, spaceToEnd) * sizeof(Sint32),
               cudaMemcpyDeviceToHost);
    if (spc > spaceToEnd) {
        cudaMemcpy(rawSoundIntBuffer.data(),
                   dev_soundInt + ch * miter + spaceToEnd,
                   (spc - spaceToEnd) * sizeof(Sint32),
                   cudaMemcpyDeviceToHost);
    }
}
rawSoundIntWritePos += chunk;
```

The 2-cudaMemcpy-per-channel wrap pattern is identical to the float ring's two-memcpy fallback at `Pianoid_synthesis.cu:632-641`. Pseudo-code; final indexing must be matched against the kernel's `sampleIndex` formula (`MainKernel.cu:492`: `(outerSoundChannel-1)*samplesInCycle + main_cycle_index`).

**Verification.** Before any per-pitch interpretation, the readback MUST be cross-checked against the kernel's per-sample value — e.g. by adding a temporary printf at MainKernel.cu:492 for the first N samples of channel 0 and comparing against the corresponding slice of `getRawSoundRecordInt()` output. dev-soundint-live's kernel probe measured `output ±0.0078 → soundInt ±6.3e6` at `mvc = 7.99902e8` (Belarus MFeq vol=100); the new readback should report the same values within float-rounding. **Revert the printf before commit.**

**Constraint flagged:** like FIR, `dev_soundInt` is the Online-driver-input. In Offline regime it is still written by MainKernel (the per-sample write at MainKernel.cu:512 runs unconditionally) — so the Sint readback DOES work offline, even though FIR doesn't. The Sint source therefore works in both modes; the FIR source works only Online.

**PianoidResult-layer change (Python side, the chart-fn entry point):**
- Add `self.sint_sound` field to `__init__` (dtype `np.int32`).
- Add `load_sint_audio_from_pianoid(length=None)` method that calls `self.p.getRawSoundRecordInt()` and reshapes to `(num_channels, samples)` per the per-channel-`samplesInCycle` layout (matching the kernel's `sampleIndex` formula).
- Add `get_sint_audio(channel=0, result_type="ndarray", as_float=False)` accessor — when `as_float=True`, returns `self.sint_sound[channel] / INT32_MAX` (matches the `getCurrentCycleAudio` Sint→float normalisation convention documented in DEBUG_DATA.md:76).
- Files: `PanoidResult.py` (~35 LOC).

---

## 6. Sint hook — re-derivation plan (cherry-pick is NOT available)

**Correction (team-lead, 2026-05-30):** the dev-soundint-live stash and `feature/soundint-readback` branch have been pruned. `git stash list` is empty for soundint; commit `26799bf` is not reachable. The code is gone — only the design record in the archived session log survives.

This is therefore a fresh implementation, not a cherry-pick. The estimated LOC and build cycles in §11 + §8 are unchanged (~120 LOC C++ across 5 files + 1 `--heavy --release` build); the cost was always going to be these LOC, the stash would only have saved typing time and the bug-fix iteration. The known layout bug means **even a successful stash apply would have needed re-writing the append loop anyway** — so the practical loss is small.

**Source of design truth:** `docs/development/logs/dev-soundint-live-2026-05-29-153254.md` — read its "RING MECHANISM (MEASURED)", "Staged Pianoid_synthesis.cu edits", "Data Model Card", and the "Hook-bug root cause pinned" section. Those four blocks contain every piece of design knowledge we need; §5.3 above distils them into the concrete edit table + sample-loop sketch.

**Re-derivation checklist (Phase B):**

1. **Read the archived log end-to-end** before writing any new code — especially the "★★★ H1/H2 RESOLVED" measurement that pins `mvc = 7.99902e8` and the kernel-probe ground truth (`output ±0.0078 → soundInt ±6.3e6` for Belarus MFeq vol=100 pitch 56). These are the verification targets for the new hook.
2. **Write the Phase A Data Model Card** referencing the existing CLAUDE.md "Same name, different thing" entry for `dev_soundFloat`-pre-volume vs `dev_soundInt`-post-volume, and the dev-soundint-live-measured fact about per-channel write extent.
3. **Implement** per the table in §5.3.
4. **Verify** via a temp `printf` at MainKernel.cu:492 against `getRawSoundRecordInt()` slice — assert they match within float-rounding. Revert the printf before commit.
5. Only after the verify passes, wire the Sint source into `sound_test_function`.

No `git stash show -p` step is possible; the design knowledge is the substitute.

---

## 7. Frontend UI

**Pattern: a new chart parameter pane wired into the existing `newWindowChart` renderer, plus a `ChartSelector`-discoverable entry.**

### 7.1 Discovery — auto-wired

The chart appears in the existing `ChartSelector` Charts tab automatically because:
- `chart_registry.sync_config_file()` registers the new chart on backend startup
- `GET /graph_names` returns it
- `useChartTypes()` (PianoidTunner) refetches on `presetVersion` bump

No code change for discovery.

### 7.2 Parameter pane

`ChartSelector` renders the parameter form from `ChartType.parameters`. Today's auto-renderer handles `string`, `number`, `int`, `float`, `boolean`, `choice` uniformly. For the `play_kind` choice and the various comma-string fields, this works out of the box — but the UX of typing `"60,64,67"` into a chord field is poor.

**Two scope variants for the pane:**
- **S1 (minimum-LOC):** rely on the auto-renderer. Field labels carry the format hint (e.g. `"MIDI pitches (CSV)"`). Pane is functional but unfriendly.
- **S2 (custom pane):** add a `SoundTestParamsPane.jsx` matched to `chartType === "sound_test"` in `ChartSelector` (one if-branch). The pane provides:
  - MUI `ToggleButtonGroup` for `play_kind`
  - For `note`: single `NumInput` + Note name label
  - For `chord`: dynamic list of `NumInput` + `+`/`−` buttons; emits CSV
  - For `sequence`: drag-orderable rows of `(NumInput pitch, NumInput velocity, NumInput duration_ms)`; emits parallel CSV trio
  - `Channels`: `ToggleButtonGroup` populated from `availableOutputChanels` + an `All` toggle
  - `Sources`: 4-up `ToggleButton` group with persistent dark-theme styling (already the project's MUI convention)
  - `tail_ms` + `display_length_ms`: `NumInput`

S2 follows the project's Frontend UI Standards (MUI dark, `NumInput` everywhere, no Tailwind, no animation libraries).

### 7.3 Rendering

The chart's multiple ChartData arrays are already plotted by `newWindowChart.jsx`'s multi-chart layout. With `render_hints`'s `x_axis_name="time (ms)"` per chart they share a uniform x-axis. The legend automatically picks up `chart_headers`. No renderer change required beyond the existing dev-ratiochart `render_hints` channel (released 2026-05-24).

**ASCII mock of the pane:**

```
+---------------------- Sound Test ----------------------+
|  Kind: ( Note ) ( Chord ) [ Sequence ]                 |
|                                                        |
|  Sequence:                                             |
|   [+] [60] [100] [500]                                 |
|   [+] [64] [100] [500]                                 |
|   [+] [67] [100] [500]                                 |
|   [+] [72] [120] [800]                                 |
|                                                        |
|  Channels:   [ All ] [ 0 ] [ 1 ] [ 2 ] [ 3 ]           |
|  Tail (ms):           [ 2000 ]                         |
|  Display window (ms): [ 0     ] (0=full)               |
|                                                        |
|  Sources:    [✓ Kernel ] [  FIR  ] [✓ Sint ] [ Mic ]   |
|                                                        |
|  ( Render )                                            |
+--------------------------------------------------------+
                              ↓
   +------ Sound Test: Sequence (4 notes) -----------+
   |                                                 |
   |  Kernel ch0   ━━━━━━━━━━━━━━━━━━━━━              |
   |  Kernel ch1   ━━━━━━━━━━━━━━━━━━━━━              |
   |  Sint   ch0   ━━━━━━━━━━━━━━━━━━━━━              |
   |  Sint   ch1   ━━━━━━━━━━━━━━━━━━━━━              |
   |                                                 |
   |       time (ms) →                               |
   +-------------------------------------------------+
```

---

## 8. Scope variants — pick before Phase B

| Variant | Includes | Cost (engine builds) | Audio-mode |
|---|---|---|---|
| **S1 — Sint only** | `sint` source via stash (fixed); auto-render pane; offline render channel-0 only | 1 `--heavy --release` build (Sint hook fix) | audio_off works for channel-0 |
| **S2 — Sint + Kernel + multi-channel** | Add multi-channel `collectAudio` so `kernel` + `sint` cover all channels in offline mode; custom param pane (§7.2) | 1 `--heavy --release` build (combines §5.1 + §5.3) | audio_off works for all channels |
| **S3 — All four sources** | Add `fir` source via post-FIR readback hook (§5.2); online-only for FIR; mic source via `/play_keyboard`-style startMicCapture | 1 `--heavy --release` build (combines §5.1 + §5.2 + §5.3) | full coverage: audio_off for kernel+sint, audio_on for fir+mic |

The proposal **recommends S3**, because it cleanly fulfils the user's spec ("Several sources can be chosen") and the three engine-side patches are mutually independent file edits that all need the same `--heavy --release` rebuild. S2 is the conservative fallback if the FIR readback hook turns out to be more invasive than estimated.

---

## 9. Test plan

### 9.1 Backend unit tests (`tests/unit/test_sound_test_chart.py`)

Pure-Python, no engine. Under the Phase A3 directive ("all extraction via PianoidResult"), the chart-fn test mocks the **PianoidResult fields**, not the raw C++ getters — proving the chart fn never reaches around PianoidResult.

Use a `MagicMock` pianoid that supplies:
- `pianoid.mp.sample_rate()`, `pianoid.mp.mode_iteration`, `pianoid.mp.num_channels`
- `pianoid.pianoid.runOfflinePlayback` → no-op
- `pianoid.pianoid.startMicCapture` / `stopMicCapture` → known float buffer (the chart fn legitimately calls these for the mic source, since `set_mic_audio` is a caller-attachment pattern by design)
- `pianoid.result.sound` pre-populated `(num_channels, samples)` ndarray (for kernel source)
- `pianoid.result.post_fir_sound` pre-populated `(num_channels, samples)` ndarray (for fir source)
- `pianoid.result.sint_sound` pre-populated `(num_channels, samples)` int32 ndarray (for sint source)
- `pianoid.result.mic_audio` pre-populated mono ndarray after `set_mic_audio` (for mic source)
- A `_load_*_from_pianoid` set of MagicMock methods that no-op (the engine→host transport — verified separately in §9.2)

**Architectural assertion in the test:** assert that `pianoid.pianoid.getRawSoundRecord` / `getRawFilteredFloatRecord` / `getRawSoundRecordInt` are **NEVER called** by the chart fn (their `.assert_not_called()` after each test case). The only allowed C++ calls from the chart fn are `runOfflinePlayback`, `startMicCapture`, `stopMicCapture`, `resetStringsState`, `runSynthesisKernel`, `clearRecords`. This guards the architectural contract.

A separate set of PianoidResult-loader tests (`tests/unit/test_pianoid_result_loaders.py`, NEW) covers each `load_*_from_pianoid` method in isolation: given a known raw buffer from a mocked C++ getter, assert the reshape produces the correct `(num_channels, samples)` shape and per-channel values.

Cases:
- `play_kind=note` → exactly one ChartData per (source × channel)
- `play_kind=chord` → 3 NOTE_ON events at cycle 0 + 3 NOTE_OFFs at duration cycle
- `play_kind=sequence` → N back-to-back NOTE_ON/NOTE_OFF pairs
- `sources="kernel,sint"` + `channels="0,2"` → 4 charts in legend order: kernel ch0, kernel ch2, sint ch0, sint ch2
- `channels="all"` → expands to all preset output channels
- `display_length_ms > 0` → each chart truncated to that window
- Invalid pitch → returns error in `text_fields`, no crash
- `sources="fir"` in offline mode → returns single empty chart + warning text
- `sources="mic"` in offline mode (audio_driver_type=0) → error in `text_fields`

### 9.2 Backend integration test (`tests/integration/test_sound_test_offline.py`)

GPU required, no audio. Uses `pianoid_audio_off` fixture. Calls the actual chart function with `sources="kernel,sint"` and `pitches="60"` and asserts:
- Multi-channel `kernel` source: channel-N amplitude > channel-0 / 100 IFF preset has channel-N mapped (Belarus 4-channel)
- `sint` source: peak ≈ `kernel_peak * main_volume_coefficient` and `|sint| ≤ INT32_MAX` (no overflow)
- Sample count matches cycles × samples_per_cycle

### 9.3 Frontend Jest test (`src/components/__tests__/SoundTestParamsPane.test.js`)

Renders the pane, simulates user setting `play_kind=chord`, adds 3 rows, asserts the emitted CSV is `"60,64,67"` etc. Mocks `usePreset` for `availableOutputChanels`.

### 9.4 Live-UI verification (per CLAUDE.md Audio Verification Rule)

| Sources requested | Mode | Skill |
|---|---|---|
| `kernel,sint` (or subsets) | audio_off | `/test-ui` |
| Any selection that includes `fir` | audio_on | `/test-ui` audio_on variant — drives the live engine with FIR enabled |
| Any selection that includes `mic` | audio_on + mic loopback | `/diagnose` Phase 7 (requires `_MIC_LOOPBACK_CONFIGURED=True`) |

This honours the strict A1 binary contract from `docs/development/TESTING.md`.

---

## 10. Data Model Card — for Phase B (still Phase-A draft)

| Fact the chart relies on | Doc citation | Inferred-only? |
|---|---|---|
| `dev_soundFloat` is PRE-volume, PRE-FIR; per-sample write `soundFloat[sampleIndex] = float(output)` at `MainKernel.cu:513` | SYNTHESIS_ENGINE.md "Per-sample write" + Audio Output diagram lines 681-689 | **N** (verbatim) |
| `dev_soundInt` is POST-volume, PRE-FIR; per-sample write `soundInt[sampleIndex] = Sint32(output * main_volume_coefficient)` at MainKernel.cu:512 | SYNTHESIS_ENGINE.md "Per-sample write" + DEBUG_DATA.md:54 "Audio buffers `dev_soundFloat`, `dev_soundInt` — production audio path" | **N** |
| `dev_filteredSoundFloat` / `dev_filteredSound` are POST-FIR; written only when `FIRfilterON==true`; FIR runs in `pushCycleAudioToDriver()` (Online regime only) | MEMORY_MANAGEMENT.md:185-186 + PLAYBACK_SYSTEM.md:205 + SYNTHESIS_ENGINE.md:964 | **N** |
| Buffer layouts: `dev_soundFloat` / `dev_soundInt` are `(num_channels, samples_per_cycle)` per cycle, indexed as `sampleIndex = (outerSoundChannel-1)*samplesInCycle + main_cycle_index`. `rawSoundBuffer` is `(num_channels, samples)` flattened interleaved over cycles. | SYNTHESIS_ENGINE.md "Audio Output" §sampleIndex + Pianoid_synthesis.cu:613 (`chunkSize = mode_iteration * num_channels`) | **N** |
| Kernel writes ONLY `[0, samplesInCycle)` per channel; tail `[samplesInCycle, mode_iteration)` per channel is uninitialised in `dev_soundInt` when FIR is off (FIR-on path memsets via Pianoid_synthesis.cu:539). | Source-measured by dev-soundint-live (kernel probe vs broken-ring readback, log entry 2026-05-29T18:35:00Z) | **Y — measured but not yet in any doc.** Phase B MUST update DEBUG_DATA.md "Audio Extraction" with this fact before reusing the stash. |
| `OfflinePlaybackEngine::collectAudio` collects only channel 0 (`getCurrentCycleAudio` copies only `mode_iteration` floats from `dev_soundFloat`'s channel-0 region) | Source-confirmed: Pianoid_synthesis.cu:117-127; chartFunctions.py:54-56 only fills `result.sound[0]` | **Y — undocumented gap.** Phase B MUST update DEBUG_DATA.md + chartFunctions docstring with this fact BEFORE implementing multi-channel render. |
| `main_volume_coefficient` is exposed via `pianoid.get_current_volume_coefficient()`; measured live value at vol=100 Belarus MFeq = `7.99902e8` (dev-soundint-live kernel probe). The C++ getter `getMainVolumeCoefficient()` that dev-soundint-live added has been pruned along with `feature/soundint-readback` — `pianoid.get_current_volume_coefficient()` is the only path today. | pianoid.py:753 docstring + dev-soundint-live archived log "★★★ H1/H2 RESOLVED" entry | **N** for the Python wrapper; the C++ getter no longer exists. Phase B: only the Python wrapper is needed for the chart function. |
| `startMicCapture(max_duration_ms)` is mono float32 at `pianoid.mp.sample_rate()`. Returns the captured buffer from `stopMicCapture()`. Requires `audio_driver_type ≠ 0` (audio_on). | backendServer.py:1953 / :1985 (used by `/play_keyboard capture_mic`) | **N** |

**`[DMC-COMPLETE]` will be emitted only once the two "Y" rows are resolved** (either by reading the actual source confirming the inference, OR by closing the doc gap first). This is Phase A's deliberate stopping rule.

---

## 11. Risk / scope notes

- **CUDA rebuild required.** All three engine deltas (5.1, 5.2, 5.3) touch `.cu` / `.cuh` files. Must use `build_pianoid_cuda.bat --heavy --release` (per CLAUDE.md memory: `--both` is broken; release-only is the workaround). Pre-build hygiene: `tasklist //M pianoidCuda.cp312-win_amd64.pyd` to find holders; kill PIDs.
- **C4 file-size check.** `chartFunctions.py` is already RED (~2700 LOC). The new `sound_test_function` is ~150 LOC; that lands at ~2850 LOC, deeper in the RED zone. Recommended: as part of Phase B, extract the new function into `chartFunctions/sound_test.py` (sibling module imported by `chartFunctions.py`). This stays additive and avoids growing the god-object further. **Flag for user decision in Phase B.**
- **Sint hook is the riskiest new code.** The dev-soundint-live measurement showed that the naïve `mode_iteration*num_channels` chunk-copy rails INT32 garbage from uninitialised tails — the per-channel `samplesInCycle` copy must be used from the start. The fix is mechanically simple but MUST be verified against a kernel probe (per §5.3 "Verification") before the user trusts any Sint chart.
- **FIR-online-only constraint** must be visible in the UI: if the user selects `fir` in audio_off, the chart must render the warning prominently in `text_fields` so the user understands why that overlay is empty.
- **Mic source blocks** for `total_play_ms + tail_ms`. With a 10-note sequence at 500 ms each + 2 s tail, that's 7 s of HTTP-blocking. Acceptable for a one-shot diagnostic chart (matches `/play_keyboard capture_mic` precedent).
- **No `note_playback` deprecation.** The new `sound_test` chart is additive; `note_playback` stays as the deterministic test-ui reference. No risk to existing `/test-ui` flows.
- **`include_full_result` size.** With multi-channel + sequence + 5-s tail, the full `PianoidResult` payload can be ~30 MB. Keep default `false` (matches `note_playback`).

---

## 12. Phase A → Phase B decision points (asked of the user)

1. **Scope: S1 / S2 / S3** (§8). Recommendation: **S3**.
2. **Parameter pane: auto-rendered (low cost) vs custom `SoundTestParamsPane.jsx`** (§7.2). Recommendation: **custom pane** (S2 of pane) — the multi-row sequence editor is the difference between "usable" and "scriptable only".
3. **C4 split: extract `sound_test_function` into a sibling module** (§11) or accept growing `chartFunctions.py` past 2850 LOC. Recommendation: **extract** (matches the project's recent dev-collreorg pattern).
4. **Sint-hook layout fix: per-channel `samplesInCycle` copy** (cleaner) **vs `cudaMemset(dev_soundInt)` every cycle when FIR off** (smaller patch, +memset cost). Recommendation: **per-channel copy** — zero runtime cost.
5. **Frontend pane location: existing `ChartSelector` body** (consistent with every other chart) **vs dedicated mosaic pane**. Recommendation: **`ChartSelector` body** — the user already lives in that tab for every other chart.

---

## 13. Investigation history (this proposal's supporting docs)

- `docs/development/logs/dev-stest-4a7c-2026-05-30-205710.md` — this session's docs sweep + Data Model Card.
- `docs/development/logs/dev-soundint-live-2026-05-29-153254.md` — full design + measurement record of the Sint readback hook attempt. The branch + stash have been pruned; only this log survives. The Sint re-implementation plan in §5.3 / §6 derives entirely from this log + the engine source it cites. **Do not attempt `git stash apply` — it will fail.**
