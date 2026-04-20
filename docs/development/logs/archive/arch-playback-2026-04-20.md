# Session log — arch-playback — 2026-04-20

## Task

Research-only architecture review of Pianoid online + offline playback
subsystems against a user-stated target vision (single MIDI-formatted online
event path; consolidated parameter path; offline with state snapshot/restore
and internal audio format convertible to WAV).

## Inputs

- User vision pasted by orchestrator (2026-04-20).
- `docs/development/DISTORTION_INVESTIGATION_CONTEXT.md` (ctx-distortion
  snapshot; P1/P2/P3 hypotheses).
- Active user context: `sound_derivative_order = 2`; space-clean /
  MIDI-dirty distortion; artifacts persist after note-off.

## Reading order (docs-first)

1. `docs/index.md`
2. `docs/architecture/SYSTEM_OVERVIEW.md`
3. `docs/architecture/DATA_FLOWS.md`
4. `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md`
5. `docs/modules/pianoid-middleware/REST_API.md`
6. `docs/modules/pianoid-middleware/OVERVIEW.md`
7. `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`
8. `docs/modules/pianoid-cuda/PARAMETER_SYSTEM.md` (§ overview only, for
   granular-vs-bulk context)
9. `docs/development/WORK_IN_PROGRESS.md`
10. `docs/development/DISTORTION_INVESTIGATION_CONTEXT.md`

## Source code sampled (only after docs)

- `PianoidCore/pianoid_cuda/OnlinePlaybackEngine.cu` (entire)
- `PianoidCore/pianoid_cuda/OfflinePlaybackEngine.cu` (entire)
- `PianoidCore/pianoid_cuda/PlaybackCycleExecutor.cu` (entire)
- `PianoidCore/pianoid_cuda/EventDispatcher.cu` (entire)
- `PianoidCore/pianoid_cuda/PlaybackEvent.h` (entire)
- `PianoidCore/pianoid_cuda/MidiEventConverter.h` (entire)
- `PianoidCore/pianoid_cuda/Pianoid.cu` — targeted reads:
  - runOfflinePlayback (line 2952)
  - stopEngineKeepAudio / restartOnlineEngine / executeSingleMeasurementCycle
    (lines 2540-2592)
- `PianoidCore/pianoid_middleware/pianoid.py` — targeted reads:
  - `enter_calibration_mode`/`exit_calibration_mode` (363-478)
  - `render_midi_offline` (520-583)
  - `perform_midi_command` (785-833)
  - `play_mode` (877-936)
  - `start_realtime_playback_unified` (1256-1341)
  - `MIDI_listener_unified` (1353-1389)
  - `add_realtime_event` (1391-1434)
  - `load_midi_for_online_playback` / `stop_online_midi_playback`
    (1478-1617)
- `PianoidCore/pianoid_middleware/backendServer.py` — targeted reads:
  - WS handlers (127-370)
  - REST `/play` (1162-1262), `/play_mode` (1264-1277),
    `/playback_stats` (1313)
- `PianoidCore/pianoid_middleware/parameter_manager.py` — grep
  (`_gpu_upload`, `waitForParameterUpdate`, `send_*_params_to_CUDA`,
  `setNew*Parameters`). No `time.sleep` matches.
- `PianoidCore/pianoid_middleware/chartFunctions.py` — `_stop_online_engine`
  / `_restart_online_engine` helpers (1-40); grep for offline pattern.
- `PianoidCore/pianoid_cuda/` — glob to confirm absence of
  `MidiInputListener.h/.cpp` (P2 drift confirmed).

## Key findings

1. **All four live-event producers already converge on `RealTimeEventBuffer`
   — except `play_mode` (A5)**, which bypasses the queue and calls
   `pianoid.exciteMode()` directly while the engine thread is active.
   Unification blocker.
2. **Three producer dedup policies** — per-sid WS, module-level REST,
   none for MIDI listener. Inconsistent.
3. **Doc/code drift confirmed (P2).** `PLAYBACK_SYSTEM.md §MidiInputListener`
   describes a C++ RtMidi callback listener with pybind11 bindings; no such
   file exists in the source tree. `AddArraysWithCUDA.cpp:523` marks legacy
   MIDI listener as removed. Flagged in review §7.
4. **Parameter dispatcher is ~80% unified** at
   `ParameterManager.update_parameter()`. WS handlers re-implement the same
   glue that REST uses; cleanup opportunity.
5. **WIP.md "Parameter Update Sleep Removal" is stale** — the refactor has
   landed. `parameter_manager.py` has zero `time.sleep` matches; all bulk
   paths use `_gpu_upload` which calls `waitForParameterUpdate()`. Noted
   for a future doc sync pass.
6. **Offline already has a semi-offline mode** with audio driver kept open
   (`enter_calibration_mode(keep_audio=True)` +
   `executeSingleMeasurementCycle()`). It is very close to the user's
   offline vision; only state-snapshot/restore and the
   internal-format/play-through-driver primitives are missing.
7. **Two offline flavors coexist** — pure `runOfflinePlayback` (driver
   silent) and semi-offline calibration (driver alive, engine loop stopped).
   Unifying these under an `offline_session` context manager is the core
   of the proposal.
8. **`MidiEventConverter` already has half the MIDI-first infrastructure**
   (`fromMidiBytes`, `fromMidiRecord`, `isModeExcitation(0xF1)`,
   `createModeExcitationEvent`). Proposal reuses these.

## Output artifacts

- `docs/development/PLAYBACK_ARCHITECTURE_REVIEW.md` — full architecture
  review, 8 sections per orchestrator spec (§1 current online, §2 current
  parameter, §3 current offline, §4 gaps, §5 proposal, §6 migration plan,
  §7 open questions, §8 evidence).

No source edits. No docs edits besides the new review doc + this log.

## Status

Research complete. Plan pending user review. Staying alive and idle for
orchestrator follow-up.
