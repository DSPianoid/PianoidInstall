# Excitation-write stall ("control is gone") — measurement record, 2026-11-03

User report (bug report `bugreport-2026-11-03T09-11-48-963Z-manual-…`, tuning hammers on the Hammers
layout): the UI stopped controlling the engine; MIDI still played. Auto-reports: `/health` unresponsive
for ~63 s, eight times. Fixed by dev-hstall (Core `feature/dev-hstall-write-stall`, Tunner
`feature/dev-hstall-write-coalesce`).

## What the logs showed

- All 70 backend gaps of the day (11–175 s with no HTTP answered) ended with a
  `POST /set_parameter/excitation/…` — 88-key `mu` / `volume` writes from the excitation panel, not
  hammer writes. Hammer writes queued behind them and ran fast (131 of them in 11 s once free).
- The FE's 700 ms ack timeout re-sent each slow WS write over REST (applied twice); the 3 s degraded
  cooldown sent the next writes straight to REST; a drag added one write per debounce tick.
- "~63 s" = the FE outage detector (`OUTAGE_MAX_MS` 60 s + a 4 s probe timeout), not a backend timeout.

## Measurements

| Condition | 88-key `mu` write (same route, same values as the UI) |
|---|---|
| Live backend, 46 h uptime, 8.7 GB private / 1.0 GB working set | 31.6, 28.3, 25.6, 38.3, 32.5 s |
| Fresh backend (same preset snapshot + load settings), 1.6 GB | 0.77, 0.59, 0.72 s; under chart + hammer-shape polling 0.59, 0.59, 0.75 s |
| Fresh, 3 concurrent copies | all done in 1.9–2.2 s |
| Fresh, private inflated ONLY through `/midi/ports`: 2.2 / 3.1 / 3.9 GB | 0.9 / 2.2 / 3.0 s (N=3 each) |
| Fixed backend after 27.7k `/midi/ports` calls (private flat 1576 MB) | 0.57, 0.56, 0.73 s |

- py-spy on the live write: 98% in `temporal_curve_impulse → gpu_force_curve`
  (`excitation_coefficients._recompose_pitches`); native dumps 7/7 in `RtlAllocateHeap` /
  `RtlFreeHeap` under numpy. The same 528 curve computations standalone: 0.56 ms each; in the live
  process ~50 ms each. The maths is fine; the 46 h process heap was not.
- Leak soaks (60 s per request type): `GET /midi/ports` 37 KB/call; ALL-mode MIDI listener idle
  ~29 KB/s (rescan every 1 s); `/health`, `cfl_ratio` chart, `get_hammer_shape`, hammer writes ~0.
  An in-process diagnostic route: a transient `rtmidi.MidiIn()` per request leaks ~38 KB; listing
  through one shared instance 0.9 KB/request. Standalone python-rtmidi does not leak — why the C++
  object is not freed inside the backend is not pinned (37 KB ≈ the RtMidiIn 1024-message queue).
- During a WS excitation write, `ping_ws` acks in 2–175 ms (the FE probe's premise).

## Fix

- Core: `midi_ports.py` — one long-lived `MidiIn` / `MidiOut` for every port LISTING
  ([MIDI_SYSTEM](../modules/pianoid-middleware/MIDI_SYSTEM.md)).
- Tunner: `emitWithAck` probes `ping_ws` before treating a late ack as half-open; `deliverLatest` keeps
  one write in flight per debounce key, newest wins
  ([Tunner OVERVIEW](../modules/pianoid-tunner/OVERVIEW.md)).

## Open

- The FE fix is verified by Jest (real hook code, socket mocked) and by the live `ping_ws` latency
  measurement; not by a browser drag (the user's open tab polls `:5000`, so no agent stack ran there).
- Optional: compute `level_impulse` for all levels / pitches in one numpy pass (PianoidBasic) — fewer
  temporaries per write; not needed for the stall.
- Pre-existing failing unit tests on Core dev 2b5bc64 (unchanged by this work): 4 in
  `test_midi_player.py` (pedal decode), `test_rig_pipeline::test_registry_commands_and_safe_ceiling`,
  4 in `test_start_right_away_binary.py`.
