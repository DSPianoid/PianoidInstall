# dev-obuf1 review — offline buffer de-interleave, param.set missing pitch, bug-report triage (2026-10-25)

**Status:** committed on `feature/dev-obuf1-offline-buffer` (PianoidCore off `dev` ce6f801, PianoidInstall off
`master` 8a1e709). NOT merged, NOT pushed. User approval to implement: 2026-10-25 "Yes go". No compiled files changed,
no rebuild needed (middleware `.py` only: the backend picks it up on restart).

Source reports: `PianoidCore/logs/reports/bugreport-*-assistant-app_bug-{8761b5c4,06c895bc,bc956d19}*.json`.

## 1. Offline buffer read as mono (8761b5c4, 06c895bc)

`getRecordedAudio()` holds, per 64-sample cycle, one block per output channel `[ch0 × 64, ch1 × 64, …]`
([TESTING.md](../TESTING.md) "p.getRecordedAudio()"; channel 0 = output pitch 128). Measured: raw size = 7.000 ×
cycles × 64 for the 7-channel preset.

**Fix.** One owner of the layout: `PanoidResult.deinterleave_cycle_blocks` (+ `load_offline_channels(p, mp)` for
callers that must not overwrite the shared `result.sound`). `load_offline_sound_from_pianoid` and
`get_sound_from_pianoid` use it (the two copies of the reshape are gone).

| Caller of `getRecordedAudio` | Before | After |
|---|---|---|
| `backendServer` `/play_keyboard` offline | flat buffer → mono WAV (7× long) | `load_offline_channels(...)[channel]`, new `channel` arg (default 0, 400 if out of range), `num_channels` in the reply |
| `chartFunctions._load_offline_sound_to_result` (note_playback, mode_test) | flat buffer written into `result.sound[0]` | helper deleted; `pianoid.result.load_offline_sound_from_pianoid()` |
| `chartFunctions.play_note_offline_action` (WAV export) | flat buffer → `exportAudioToWav` (mono) | channel 0 |
| `pianoid.py` offline MIDI → WAV | flat buffer | channel 0 |
| `auto_tuner.MeasurementEngine.render_note` (docstring already said "channel 0") | flat buffer → pitch / RMS measured on scrambled data | channel 0 |
| `synthesis_tuner` | already de-interleaved | unchanged |
| `output_level` (output_scale calibration peak) | `max|x|` over the flat buffer = peak over all channels | unchanged (layout-independent) |

Also fixed in `/play_keyboard`: peak normalisation had an absolute floor (`peak > 1e-9`); the pre-volume kernel output
of this preset peaks at ~1e-13, so the WAV was **all zeros**. Now any non-zero peak is normalised.

### Evidence — offline-render surface (in-process audio_off, ONE Pianoid, preset `Tuning18-10-26ver1_work_assistant_3`, si 8, d2, a512, 48 kHz)

Harness: [`dev-obuf1-offline-buffer.py`](../diagnostics/dev-obuf1-offline-buffer.py); raw results
[`before`](../diagnostics/dev-obuf1-before.json) / [`after`](../diagnostics/dev-obuf1-after.json).

| Signal / metric | Before | After |
|---|---|---|
| `/play_keyboard` 3 pitches × 1500 ms: WAV duration vs rendered (5250 cycles = 7.0 s) | 49.0 s (2 352 000 samples), **all-zero** | 7.0 s (336 000 = 5250 × 64) |
| note_playback 12 s (+5 s tail = 17 s): `result.sound[0]` duration | 119.0 s | 17.0 s |
| 7-block periodicity: median \|ΔRMS\| lag 7 / lag 1 (64-sample blocks) | 0.27 (level repeats every 7 blocks) | 0.90 (WAV: 0.96) |
| jump ratio at 64-sample boundaries (mean \|Δx\| boundary / interior) | 19.1 | 1.00 (WAV: 1.01) |
| 750 Hz (= 48000/64) line prominence, 0.5–2.5 s | +16.2 dB | −1.4 dB (ch1 +1.1, pitch 48 +1.7) |
| `param.set string from58to61` without 60 (Flask route) | (report: 416 traceback, 59 written, 61 not) | 400 `missing_pitch_values` [60]; damper 58/59/61 unchanged |

**750 Hz cycle artifact: gone.** It was the de-interleave scramble. (A 72–82 dB line at 3001.5 Hz remains in ch0/ch1
of pitch 67 only — 4.9 dB for pitch 48 — so it is pitch-specific content, not a cycle artifact.)

## Dispersion-damping re-test (report 06c895bc method)

Pitch 67 (G4, f0 measured 390 Hz), velocity 100, 12 s; channel 0; 0.2 s Hann STFT, per-partial slope fitted 0.3–3 s.
`dispersion_damping` base = 1.08e-14 (the `_3` preset value).

**Measurement trap found:** with the engine stopped (audio_off, no realtime loop), an edit can miss the next offline
render — it lands one render late on alternate edits (`dev-obuf1-offline-param-lag.py`: x1→A, x100→B applied, x1→D
still x100, E = x1; |D−C|/|C| = 1e-4). The table therefore uses a SECOND render after each edit. WIP entry filed
(C++, not touched here).

| Partial | 390 Hz | 781 | 1174 | 1569 | 1968 |
|---|---|---|---|---|---|
| x1 (dB/s) | −7.1 | −5.4 | +0.2 | −5.7 | −10.3 |
| x10 | −9.6 | −15.2 | −21.8 | −25.9 | −26.7 |
| increment x1→x10 | −2.5 | −9.8 | −22.0 | −20.2 | −16.4 |
| x100 | −34.2 | −56.0 | below floor | below floor | below floor |

Result: **offline, dispersion damping is frequency dependent**: the x1→x10 increment grows ~n² over h1–h3 (−2.5, −9.8,
−22 ≈ 1 : 3.9 : 8.8), and at x100 h2 decays 1.6× faster than h1 within the fit window while h3+ fall below the floor
within ~1 s. Above h4 the fits flatten because those partials reach the noise floor inside the 0.3–3 s window (fit
limit, not a physics result). The report's "uniform 3.6 dB/s shift, h6–h12 identical" was the de-interleave scramble
(before: the x100 partial fits alternate −5.7 / −18 dB/s = picking different channels' blocks). Live-vs-offline was not
re-measured on the mic (audio_on, out of scope while the user's stack runs).

## 2. param.set with a pitch missing from values (bc956d19)

`pitch_values.check_pitch_values` runs first in `ParameterManager.update_pitches_physical_params_GRANULAR`
(string / physics) and in the `gauss` / `excitation` branch (same loop-then-upload shape) → `MissingPitchValues`
→ the route answers `400 {error: missing_pitch_values, missing_pitches, …}` (WS: the message in `error`). Nothing is
written (the model loop never starts; `edit_commit.commit` records nothing when `apply` raises).
Tests: `tests/unit/test_pitch_values.py` (model unchanged after a rejected call, string + physics + gauss; complete
write still applies; route 400 without traceback).

## 3. Bug-report triage

`pianoid_middleware/bug_reports.py` (one owner of the triage fields): `severity` (critical/high/medium/low/null),
`status` (open/fixed/wontfix/duplicate), `resolution {note, commits, duplicate_of, at, by}`, `triage_history`, kind
re-class (`feature_request`). Collector stamps `status: open`; `GET /bug_reports` (filters) and
`POST /bug_reports/<id>/status`; both exempt from the engine gate, classified in `write_routes` (read_only / action).
Assistant: `bug_report` draft gains `feature_request` + optional `severity`; registry `schemas/commands/bug.json`:
`bug.list` (view) and `bug.set_status` (bug_local, Ask); prompt: read `bug.list` before filing.
Docs: REST_API.md "Bug reports", the assistant README, TESTING.md.

Backfill of the 10 assistant reports (written to the live store `PianoidCore/logs/reports/` with the new update
function): see the session log for the per-report status / kind / severity / commits.

## Tests

| Suite | Before | After |
|---|---|---|
| Core unit subset (37 files touching the changed modules + 2 new) | 599 pass, 4 fail | 610 pass, same 4 fail |
| Core integration `test_sound_test_offline` + `test_measured_preset_channels` (GPU) | — | 11 pass |
| Assistant `npm test` | 146 (145 pass, 1 skip) | 148 (147 pass, 1 skip) |

The 4 failures (`test_start_right_away_binary`, `/load_preset` 400 vs 200) are pre-existing on `dev` ce6f801, not
touched here. The full `tests/unit` run exceeds the timeout on the ESPRIT SVD tests (heavy, unrelated).

## Code-quality notes

- `backendServer.py` 4532 → 4557 and `parameter_manager.py` 1001 → 1006 (both already RED): the new logic went into
  new modules (`bug_reports.py` 221, `pitch_values.py` 37); only wiring was added to the RED files.
- P1: `PianoidResult` is the sole owner of the audio-buffer layout; `bug_reports` the sole writer of triage fields.
- Not done (out of scope): the `getCurrentCycleAudio` doc row says it copies `samplesInCycle` per channel; the code
  copies `mode_iteration` (equal at 64 here). `output_level` peak spans all channels by design.
