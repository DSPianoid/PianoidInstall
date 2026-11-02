# dev-late1 review: offline edit reached only the render after next (2026-10-28)

**Status:** committed on `feature/dev-late1-offline-apply` (PianoidCore off `dev` ce6f801, PianoidInstall off `master`
d3a32b2). NOT merged, NOT pushed. Compiled change: HEAVY `--both` build required (see "Build").
Reported by dev-obuf1 ([review](dev-obuf1-review-2026-10-25.md), "Measurement trap found").

## Root cause (measured)

| Step | Where | What happens |
|---|---|---|
| 1 | `UnifiedGpuMemoryManager::updateTunableParameter` (UnifiedGpuMemoryManager.cu:457) | Every TUNABLE edit (string physics, hammer, excitation gauss, modes, deck) is an **async** H2D copy into the updating copy. The edit call returns at once. |
| 2 | `updatePollThread` → `swapBuffers` (UnifiedGpuMemoryManager.cu:874, :927) | The poll thread swaps, publishes and raises `swap_pending_` **18–183 ms later** (median 61 ms, n=20, engine stopped; `dev-late1-swap-latency.py`). |
| 3 | `Pianoid::runOfflinePlayback` → `OfflinePlaybackEngine::run` (OfflinePlaybackEngine.cu:55) | The render started at once. Cycle 0 (note-on → `parameterKernel` + the excitation gauss kernel) read the **old** working copy. The swap was adopted mid-render (`refreshSwappablePointersIfPending`, Pianoid_synthesis.cu:233). Per-point coefficients are recomputed only on `new_notes_ind`, so they were not recomputed until the NEXT render's note-on. |

Evidence: `isParameterUpdateInProgress()` was **True right before every render** (36/36 renders). Adding only
`waitForParameterUpdate()` between the edit and the render (Python, installed pyd) turned every class to applied 6/6.

| Class (one render per edit, BaselinePreset1 p60, installed pyd) | No wait | Wait before render |
|---|---|---|
| string tension | late 5/5 (each render = the previous value) | applied 6/6 |
| string dispersion_damping | late 3–4/5 (timing) | applied 6/6 |
| mode frequency (all modes) | mix of old/new (first part of render stale) | applied 6/6 |
| deck feedin | mix of old/new | applied 6/6 |
| runtime deck_feedback_coefficient (not double-buffered) | applied 6/6 | applied 6/6 |

Harness: [`dev-late1-offline-apply-lag.py`](../diagnostics/dev-late1-offline-apply-lag.py).

## Fix

`OfflinePlaybackEngine::run` calls `pianoid_->waitForParameterUpdate()` after the "main loop is not active" guard and
before cycle 0. Cycle 0's `runSynthesisKernel` then adopts the swap, and the note-on `parameterKernel` and gauss kernel
read the new copy. The engine is stopped on this path (guard), so the realtime loop never runs this code and gains no
per-cycle work. This covers every `runOfflinePlayback` / `OfflinePlaybackEngine` caller: note_playback, mode_test, `/play_keyboard`,
`auto_tuner`, `output_level`, `synthesis_tuner` and offline MIDI → WAV.
P1: the offline render owns "which parameters this render uses" and only reads the manager state via the public
`waitForParameterUpdate` (no new writer). `Pianoid.cu` (RED, 1199 LOC) is untouched; OfflinePlaybackEngine.cu 339 → 348.

Not covered: the legacy chart loops that drive `runSynthesisKernel` / `runCycle` by hand (chartFunctions.py ~558, 2189, 2741,
3929). They are not `runOfflinePlayback` and keep the old timing.

## Regression test

`PianoidCore/tests/integration/test_offline_edit_next_render.py`: 5 classes. Each one settles v0/v1 references
(each rendered twice), then alternates v0, v1, v0, v1 with ONE render per edit. Every render must be within 1 % of the reference
separation of its own value (settled-render noise is 3–4e-4).

| Test | Pre-fix binary (installed 2026-10-21) | After HEAVY build |
|---|---|---|
| `test_offline_edit_next_render.py` (5 classes) | 5 failed: tension own 1.58 / other 0.028 (late); gauss mu own 0.58 (mix); hammer position other 4e-4 (late); mode own 0.023 vs sep 0.178 (mix); deck own 8.0 vs sep 38.4 (mix) | PENDING BUILD |

## Live play (realtime thread) — finding, NOT changed here

Harness [`dev-late1-live-apply.py`](../diagnostics/dev-late1-live-apply.py): DEBUG pyd (`getParameters` = `dev_parameters`),
`OnlinePlaybackEngine` running in a thread (`audio_enabled=False`, so the cycles run free and are not paced by audio).
After a tension edit and 1 s: **0** changed per-point coefficients in 6/6 trials. After one `processSustain(0)` (any
note or pedal event): **1080** changed in 6/6 trials.

**Live is affected differently.** A string or hammer edit is not "one cycle late". It does not reach the derived coefficients
of the running engine **until the next note or pedal event**. Sounding notes keep the old value; the next key press
plays the new one. Cause: `updateMultiStringParameter_NEW` (Pianoid_parameters.cu:541; single-string :457) raises
`new_notes_ind` right after the async upload. The next cycle (1.33 ms) consumes it with the old pointers, because the swap
lands 18–183 ms later. Adopting a swap does not re-run `parameterKernel`. Modes and deck (read every cycle) apply one swap
latency (~60 ms) late. The free-running loop makes cycles shorter than live, but both are ≪ the swap latency, so
the order is the same at the paced 1.33 ms cycle.

Coordinator lead checked: `new_notes_ind = 1` (Pianoid_parameters.cu:457/541). The member is `std::atomic<int>`
(Pianoid.cuh:317), so the write is an atomic store, not a torn write. It is a **lost update**: it overwrites a pending
note-commit value (`noStrings+1`), and that cycle runs `parameterKernel` only and skips the gauss kernel for the
committed note. This is a real live race when an edit lands between a note commit and the next cycle. It is not this
bug: offline, the edit cannot interleave with the in-render commit, and waiting alone fixed 6/6.

The orchestrator asked for both, prepared as SEPARATE commits (which ones ship is the user's decision):

| Commit | Change | Test (pre-fix binary) |
|---|---|---|
| bfe5117 offline | `OfflinePlaybackEngine::run` waits before cycle 0 | `test_offline_edit_next_render.py` 5/5 red |
| 6dd0942 (a) live | `runSynthesisKernel`: `if (swap_adopted && nni == 0) nni = 1;` (`refreshSwappablePointersIfPending` returns bool) | `tests/system/test_live_edit_reaches_engine.py` red: changed coefficients 1 s after the edit `[0, 816, 0, 0]` |
| dceccb4 (b) lost update | `Pianoid::requestParameterKernel()` = CAS max to 1, used at Pianoid_parameters.cu :457/:551 (string edits), `processSustain`, `switchPreset` (Pianoid.cu:806 init left: single-threaded) | `test_note_commit_survives_param_edit.py` [string_edit, sustain_pedal] red: committed note rms **0** vs control 1.23e-5 |

(b) was measured as a real bug. An edit or a pedal raise that lands in the same cycle window as a key press silences
that note in live play. The pedal case is the realistic one: MIDI note-on plus a CC64 change within about 1.3 ms.

### Perf note for (a)

(a) adds no work on cycles without a swap: one bool test on a value that `refreshSwappablePointersIfPending` already
computes. On a swap-adoption cycle it runs the same path a note-on or pedal cycle already runs: the `dev_dec_open`
upload, a stream sync and `parameterKernel`. Measured host wall time per cycle (`dev-late1-paramkernel-cost.py`, a512/si8,
release pyd, engine stopped, 3 runs × 500 cycles each):

| Run | plain median | parameterKernel-cycle median | extra |
|---|---|---|---|
| 1 | 0.81 ms | 1.06 ms | +0.25 ms |
| 2 | 0.75 ms | 0.99 ms | +0.24 ms |
| 3 | 1.30 ms | 1.78 ms | +0.48 ms |

That is +0.24 to 0.48 ms once per swap, against a 1.33 ms budget. One swap per edit, and a dragged control
swaps at most once per swap latency (about one in 45 cycles). p99 is dominated by unrelated 12 to 30 ms host spikes
in both columns. The edit's own raise (the stale `parameterKernel`) still runs, so an edit now costs 2 parameterKernel cycles instead of 1.
An option to keep the cost neutral is to drop that raise at :457/:551, since the swap adoption covers it. It is not done here.

## Build

HEAVY `--both` is pending the orchestrator's go-ahead. The shared venv and stack are in use by livetest-ou.

## Not done

- The dev-obuf1 WIP follow-up ("OPEN: an edit can miss the next offline render") lives on `feature/dev-obuf1-offline-buffer`,
  not on `master`. Mark it fixed when both branches are merged.
- Baseline perf suite (installed pyd): 3 pass, 1 skip, 1 fail. `test_gpu_cycle_timing` fails on a single 38 ms max spike,
  which is pre-existing and unrelated (mean 0.550 ms, 18/2250 over budget).
