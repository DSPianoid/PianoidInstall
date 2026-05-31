# Chart-native playback for audio-containing charts — Phase A2 design

- **Author:** dev-stest-4a7c
- **Date:** 2026-05-31
- **Status:** Phase A2 design — awaiting user approval before implementation.
- **User request (verbatim):** "Add playback functionality (chart native) to all the charts"

---

## 1. One-paragraph summary

**The infrastructure for chart-native playback already exists** in PianoidTunner — `AudioPlayer` (`newWindowChart.jsx:7-128`) renders a per-chart play/pause/seek widget whenever the chart's response includes a `audio_data[i]` base64 WAV. The fix is **purely a backend completeness issue**: extend the audio-attaching call (`ChartArray.create_audio_to_chart`) to **every chart function that has audio data to attach**. The frontend `AudioPlayer` widget will then auto-appear next to each chart, with no PianoidTunner edits required. Browser autoplay restrictions are non-issues because the widget requires a user-gesture (Play button) before playback. No backend/REST/WebAudio glue is needed — the audio is base64 WAV embedded in the JSON chart response and decoded to a `<audio>` element on render. **Scope: backend-only Python edits to chartFunctions.py + sound_test M9 follow-up fix (the `create_audio_to_chart` call was lost between M4 design and M4 commit). The proposal is ~30 LOC of backend additions across at most 4 chart functions.**

---

## 2. What's already there

### 2.1 Frontend (PianoidTunner)

`AudioPlayer` (`PianoidTunner/src/components/newWindowChart.jsx:7-128`):
- Receives `audioData` (base64 WAV string) + `chartTitle` props.
- Decodes base64 → Uint8Array → Blob → blob URL → `<audio>` element src.
- UI: Play/Pause button + click-to-seek progress bar + elapsed / duration timestamps.
- Auto-renders next to every chart that has `audio_data[i]` non-null in the chart response (line 494: `const hasAudio = audioData && audioData[index];`).
- Uses browser-native `<audio>` element — no WebAudio API, no autoplay restrictions issues (user must click Play).

**No frontend changes are needed.** The widget already handles every per-chart audio attachment.

### 2.2 Backend (PianoidCore middleware)

`ChartArray.create_audio_to_chart(chartNo, sample_rate, ...)` (`pianoid_middleware/ChartRegistry.py:90-95`):
- For each chart entry, calls `ChartData.create_audio(sample_rate, duration, amplitude_scale, direct, frequency_scale)`.
- When `direct=True`, base64-encodes the raw chart array as a WAV at the given `sample_rate`.
- Result is attached to the chart in the JSON response as `audio_data[i]`.

**Currently called by 5 chart functions:** `sound_function`, `filter_test_function`, `mode_test_function`, `online_midi_playback_chart_function`, `play_note_offline_chart_function`.

---

## 3. Inventory — which charts need audio playback?

| Chart name | Already attaches audio? | Should it? | Why? |
|---|---|---|---|
| `sound` | ✓ yes | ✓ — already done | Raw audio buffer |
| `sound_test` (M4) | **✗ MISSING** | ✓ YES | Renders kernel/fir/sint/mic waveforms — exactly what the user wants to play |
| `note_playback` | ✓ yes | ✓ — already done | Note-render audio |
| `mode_test` | ✓ yes | ✓ — already done | Mode oscillation |
| `online_midi_chart` | ✓ yes | ✓ — already done | MIDI playback audio |
| `filter_test` | ✓ yes | ✓ — already done | Filter test audio |
| `pure_mode_test` | ✗ no | **✓ YES** | Renders pure-mode sound (function exists, line 2348) — should be playable |
| `string_shape` | ✗ no | ✗ no | Spatial string-displacement snapshot — not audio |
| `feedin` | ✗ no | ✗ no | Coupling coefficient row — not audio |
| `feedback_diagnostic` | ✗ no | ✗ no | Mode-decay envelope — not really audio |
| `hammer_shape` | ✗ no | ✗ no | Spatial hammer force — not audio |
| `hammer_temporal` | ✗ no | ✗ no | Temporal hammer force envelope — possibly playable but not meaningful (very short) |
| `block_output_data` | ✗ no | ✗ no | GPU debug record snapshot — not audio |
| `profiling` | ✗ no | ✗ no | Timing data — not audio |
| `test_volume_parameters` | ✗ no | ✗ no | Volume coefficient curve — not audio |
| `tuning_report` | ✗ no | ✗ no | Per-pitch tuning offsets — not audio |
| `cfl_ratio` | ✗ no | ✗ no | CFL stability ratio scatter — not audio |

**Net deltas:**
- `sound_test` (mine, M4 omission) — must add `create_audio_to_chart` call.
- `pure_mode_test` — add `create_audio_to_chart` so the user can hear the rendered mode.

That's it. **2 chart functions, ~3 LOC each.**

---

## 4. Why "chart native" is the right architecture

The user wrote "chart native" — meaning the playback belongs to the chart, not a global panel. The existing `AudioPlayer` mounted next to each chart in `newWindowChart.jsx:506` already satisfies this:

```jsx
{audioData && audioData[index] && (
  <AudioPlayer
    audioData={audioData[index]}
    chartTitle={chartHeaders[index]}
  />
)}
```

Each chart series in a multi-chart response (like sound_test's 4-channel kernel + 4-channel sint + mic) gets its own AudioPlayer. The user can play one source's channel-0 audio without affecting another source's channel-1.

---

## 5. Implementation plan

### 5.1 sound_test_function (M14 follow-up to M4)

Add at the end of the source-iteration loop, just before `text_fields.update`:

```python
# Attach per-chart base64 WAV so the frontend AudioPlayer widget renders
# next to each waveform. The 'all' arg covers every appended chart;
# create_audio_to_chart uses direct=True by default which writes the
# raw data as PCM (chart-fn must ensure the data is in [-1, +1] range —
# kernel/fir are already, sint is normalised via as_float=True at the
# accessor level, mic is float32 [-1,+1] from startMicCapture).
charts.create_audio_to_chart('all', sample_rate=sample_rate)
```

**Pre-attachment normalisation check:**
- `kernel` source: `result.get_synth_audio(channel)` returns float64, range [-1, 1] empirically — no scaling needed. ✓
- `fir` source: `result.get_post_fir_audio(channel)` returns float32, post-FIR float — range similar to kernel. ✓
- `sint` source: `result.get_sint_audio(channel, as_float=True)` returns float64 normalised by INT32_MAX → range [-1, 1]. ✓
- `mic` source: `result.get_mic_audio()` returns float32 from `startMicCapture`, range [-1, 1] per the driver contract. ✓

All four sources are already amplitude-compatible. **No additional scaling code needed.**

### 5.2 pure_mode_test_function

Add at line ~2348 (the existing function), after `charts.append_chart(...)`:

```python
charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())
```

### 5.3 No frontend changes

The `AudioPlayer` widget already covers the rendering. The user will immediately see Play buttons next to every chart in sound_test once the backend hot-reloads with §5.1's change.

---

## 6. Files affected

| File | Change | LOC | Lock status |
|---|---|---|---|
| `PianoidCore/pianoid_middleware/chartFunctions.py` | + 2 lines (sound_test_function audio attach) + 1 line (pure_mode_test audio attach) | ~3 | **Already mine** |
| (frontend) | none | 0 | n/a |

**No new files. No new lock acquisitions needed.** The fix lands inside an already-locked file.

---

## 7. Test plan

### 7.1 Backend unit (extension to existing test_sound_test_chart.py)

Add one case to the existing TestOfflineFunctional:

```python
def test_audio_data_attached(self):
    pianoid, cpp = _make_pianoid(num_channels=4)
    self._prepopulate_offline_result(pianoid)
    with patch.object(type(pianoid.result), "load_offline_sound_from_pianoid", autospec=True), \
         patch.object(type(pianoid.result), "load_sint_audio_from_pianoid", autospec=True), \
         patch.object(type(pianoid.result), "load_post_fir_audio_from_pianoid", autospec=True):
        charts, header, text, *extra = cf.sound_test_function(
            pianoid, include_kernel=True, channels="0", pitches="60",
            note_durations_ms="100", tail_ms=0,
        )
    _, _, audio_records = charts.get_data(scaled=False)
    # Each chart entry must have a non-None base64-WAV audio string.
    assert all(a is not None for a in audio_records), (
        f"audio_data missing for some charts: {[i for i,a in enumerate(audio_records) if a is None]}"
    )
```

Total new test cases: 1.

### 7.2 Live verification

After backend hot-reload (POST /api/stop-backend + /api/start-backend), open the sound_test chart in the user's browser tab. Each chart series should now have a Play button widget rendered next to its waveform. Click Play; audio should playback as `<audio>` element.

No regression test rider needed — this is purely additive (base64 WAV attached to JSON response, ignored by callers that don't look at audio_data).

---

## 8. Constraints + non-issues

- **Browser autoplay restrictions:** non-issue. The `AudioPlayer` widget requires the user to CLICK Play. No autoplay path exists.
- **Audio driver state:** non-issue. The audio is decoded and played **in the browser** via `<audio>` element + blob URL. No backend audio-driver involvement. Works identically in offline (audio_off) and online (audio_on) modes.
- **WebAudio API:** not used. Plain `<audio>` element handles WAV decoding natively. Cross-browser-compatible.
- **Per-chart vs per-response:** the existing AudioPlayer is mounted per-chart-entry (line 494 `audioData[index]`), which matches the user's "chart native" wording. Multi-source charts get one Play button per source × channel pair.
- **Multi-channel WAV vs per-channel separate WAVs:** the existing `create_audio_to_chart` produces one mono WAV per chart entry (because each chart entry IS one channel of audio in my data layout). User can hear each channel individually. This is the correct UX — single combined WAV would require channel mixing decisions the user might not want.

---

## 9. Phase B plan (after user approval)

| Milestone | Action |
|---|---|
| M14 | Add 2 `create_audio_to_chart` calls (sound_test + pure_mode_test); add 1 new unit test. Hot-reload backend. |
| M15 | Live verify in user's browser tab — Play button appears next to every sound_test chart. Confirm audio plays. |
| M16 | Final report + STOP before Step 10 commit. Wait for user approval. |

**Total estimated LOC:** ~5 lines backend + ~15 lines test. No C++ rebuild. No frontend changes.

---

## 10. What's OUT of scope for this proposal

The user's request was scope-clean ("chart native playback to all the charts" → 2 missing audio attachments). The following were considered but deferred:

- **Server-side playback** through SDL3/ASIO for the user to hear the sound on actual speakers via the engine: this would be a NEW backend route (POST /play_buffer or similar). NOT needed — browser playback is more responsive and works in audio_off mode where SDL3 isn't running.
- **Multi-channel WAV combination** (stereo, surround): chart fn currently produces one WAV per chart entry (channel). Single combined WAV would require mixing decisions. Defer.
- **WebAudio for per-chart effects (volume, EQ):** the existing `<audio>` element doesn't support these natively; would need WebAudio API. Not requested by user. Defer.
- **Synchronised playback across multiple charts** (e.g., "play kernel ch0 + sint ch0 in sync"): the current per-chart Play buttons don't sync. If user wants this later, it requires a higher-level controller component. Defer.

---

## 11. Open questions for user approval

Just one — and the recommendation makes the answer obvious:

1. **Confirm scope is "fill in the 2 missing audio attachments" (sound_test + pure_mode_test), NOT a bigger refactor.** Recommendation: YES — this matches the user's wording and the existing frontend infrastructure.

If user agrees: proceed with M14-M16. If user wanted something bigger (e.g., a global playback control panel, or server-side audio driver routing), this is the moment to flag it before implementation.
