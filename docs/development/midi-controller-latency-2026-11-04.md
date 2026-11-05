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

## F2b + F2c (dev-swapwait)

Core `feature/dev-swapwait` e835d6a: a condition-variable swap handoff (F2b) and the GIL released on
`waitForParameterUpdate` / `updateMultiStringParameter_NEW` (F2c). HEAVY `--both` build, the same harness, N = 3,
silent. "Before" is the merged dev build (bacc3ae, measured just before). Values are ms; each cell gives the three
runs.

| | Before | After |
|---|---|---|
| M3 swap wait, p50 | 5.35 / 5.37 / 5.44 | 0.38 / 0.37 / 0.38 |
| M3 swap wait, p99 | 7.7 / 8.0 / 7.9 | 0.97 / 0.82 / 0.75 |
| M2 overlay single write, p50 | 6.69 / 6.70 / 6.74 | 1.78 / 1.85 / 1.66 |
| M2 single write, p99 (= the max of 30) | 27.3* / 9.6 / 9.1 | 23.2* / 20.6 / 2.9 |
| M2 stream upload, p50 / p99 | 6.6-6.7 / 9.5-9.9 | 1.5-1.6 / 2.6-5.2 |
| M2 stream uploads/s | 47.6 / 49.1 / 48.4 | 47.4 / 46.9 / 46.5 (the 20 ms tick) |
| GIL probe during the M2 stream, p99 | 8.5 / 8.6 / 8.9 | **1.7 / 1.9 / 1.8** |
| M1 edit path single, p50 | 14.9 / 15.0 / 15.5 | 9.7 / 10.1 / 10.3 |
| M1 100 Hz stream achieved | 64.7 / 63.9 / 63.8 Hz | 94.9 / 94.3 / 94.2 Hz |
| GIL probe during the M1 stream, p99 | 17.4 / 20.0 / 21.0 | 9.7 / 10.0 / 9.8 |

\* The first write after the mapping is created includes the one-time clamp-frontier check (84 keys x 2,
about 20 ms). The after-run 1 outlier (20.6 ms) is a single write among 30; its other 29 are under 3 ms.

**Verdict.** The GIL criterion (<= 5 ms) is met: 1.7-1.9 ms p99 during the stream. A controller write now takes
about 1.8 ms, so one move is about 22 ms to sound, including the ~20 ms engine floor. With the swap under 1 ms, the
overlay's `TICK_S` could drop from 20 ms to 10 ms; this branch does not change it. The edit path gains too
(15 -> 10 ms).

**Merged into Core dev 2026-11-05** (06c35c9, on top of gpufit + bowsoft). Re-run on the merged build, N = 1:
swap wait p50 0.37 / p99 0.54 ms, overlay single write p50 1.72 ms, stream upload p50 1.55 / p99 2.36 ms,
GIL probe during the M2 stream p99 1.75 ms, M1 single p50 9.4 ms, M1 stream 94.8 Hz. The gain holds.

