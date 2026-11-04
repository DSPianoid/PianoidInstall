# MIDI controller latency: a keyboard-wide tension write at controller rate (dev-midictl, 2026-11-04)

**Question.** Can a pedal or knob that scales string tension across the keyboard meet the 30 ms target
([controller latency review](reviews/realtime-controller-latency-2026-11-03.md)) on the Python-only overlay
(dev-midictl Tier A)? Or does it need the review's engine-side ControllerMap (a CUDA change + HEAVY build)?

**Status: MEASURED 2026-11-04** (bow3 release engine, BaselinePreset1 = 84 key pitches, silent, N = 3 runs).

## Method

Harness `docs/development/diagnostics/dev-midictl-latency.py`:
- in-process, ONE Pianoid, release variant, `audio_on=False` (silent), BaselinePreset1;
- the realtime loop free-running in a thread (as in `tests/system/live_edit_probe.py`);
- 88 keys; N = 3 runs.

| Path | What one write is |
|---|---|
| M1 edit path (today) | `Pianoid.update_parameter('string', {p: {tension}} for every key)`: edit_commit, model, CFL indication, one swap, journal + undo entry |
| M2 overlay (dev-midictl) | `ControllerMap.match` (the listener's call) -> worker -> `reupload_string_param`: stored x factor, one swap, no model / journal / undo write |
| M3 split of an M2 write | `waitForParameterUpdate` (previous swap) / `updateMultiStringParameter_NEW` (D2H read + modify + H2D + arm) / the swap wait after it |

Each path is measured two ways:
- **single writes**, 30 of them 150 ms apart. Latency = from the call to the completed swap. The engine adopts the
  write at the next cycle, at most 1.33 ms later.
- **a 100 Hz stream for 5 s.** Measured: the achieved write rate, and how far the last write lags behind the last
  message.

A probe thread sleeps 1 ms in a loop. Its oversleep is the GIL / scheduling delay that a note on the Python
listener thread would see.

**Decision rule.**
- Tier A is enough for string and mode targets if M2 p99 <= ~10 ms (the 30 ms budget minus the ~20 ms engine
  floor), it keeps >= 50 Hz, and the probe delay stays <= 5 ms.
- Otherwise: the review's step 1 + 2, a CONTROL event + per-family scales in `parameterKernel`, applied on the
  engine thread.

## Results

All values are ms. Each cell gives the three runs.

| | M1 edit path (today) | M2 overlay (dev-midictl) |
|---|---|---|
| single write -> swap done, p50 | 14.6 / 15.4 / 15.5 | 7.2 / 7.1 / 7.0 |
| single write, p99 | 19.3 / 18.7 / 28.3 | 27.8* / 9.1 / 11.0 |
| 100 Hz stream | blocks the sender: 63.5 / 62.5 / 61.7 Hz achieved (a backlog) | coalesced: 49.3 / 48.5 / 47.1 uploads/s (the 20 ms tick); upload p99 9.5 / 9.4 / 9.5 |
| last message -> its upload done | — | 17.6 / 17.3 / 7.0 |
| GIL probe during the stream, p50 / p99 | 8.0 / 16.0 | 1.0 / 9.0, 1.0 / 8.6, 1.0 / 8.5 (idle: 0.9 / 5.0) |

\* The first write of run 0 includes the one-time clamp-frontier check: 84 keys x 2 rule + CFL checks, about
20 ms. After it, p99 <= 11 ms.

**M3: split of one M2 upload** (p50 / p99):

| Stage | Time |
|---|---|
| `waitForParameterUpdate` before the call | 0.006 / 0.013 |
| `updateMultiStringParameter_NEW` (D2H read + modify + H2D + arm) | 0.34 / 0.80 |
| the swap wait after it | 5.6 / 8.1-9.5 |

The swap wait is almost all of the cost. It comes from the 100 µs / 1 ms poll granularity of the double-buffer
handoff, and the GIL is held through it (review §2.2: no `gil_scoped_release` on `waitForParameterUpdate`).

## Verdict

| Criterion | Target | Measured | |
|---|---|---|---|
| M2 p99 | <= ~10 ms | 9.1-11 ms (steady state) | met (borderline) |
| rate | >= 50 Hz | 47-49 uploads/s, at the 50/s throttle cap | met (the cap) |
| GIL / listener delay p99 | <= 5 ms | 8.5-9 ms | **missed** |

- **Latency.** One controller move takes about 7 ms plus the ~20 ms engine floor, about 27 ms in all, under the
  30 ms target. Under a stream, the last value lands 7-18 ms after the last message (up to one 20 ms tick of
  coalescing).
- **The engine-side ControllerMap is not needed** for the string / mode targets. The Python overlay is half of
  today's edit path, and it does not block.
- **What remains is the GIL hold during the swap wait.** While a knob streams, a note on the Python listener can be
  delayed up to ~9 ms at p99 (today's edit path: 16 ms).
- **The fix is the review's two cheap engine items.** This is a small CUDA change and needs a HEAVY build, so it is
  proposed, not built:
  - F2c: `gil_scoped_release` around `waitForParameterUpdate`;
  - F2b: an event / condition-variable swap handoff instead of the sleep poll.
  F2b should also bring the swap under 1 ms, so `TICK_S` could drop to 10 ms.

Raw data: the harness `RESULT` JSON of this run (scratchpad, not committed). Re-run with the harness above.
