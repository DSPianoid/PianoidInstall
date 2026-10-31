# Half pedal: post-rebuild test plan (dev-pedal1)

Design: [MIDI_SYSTEM → Half pedal](../modules/pianoid-middleware/MIDI_SYSTEM.md#half-pedal-dev-pedal1), law: [SYNTHESIS_ENGINE](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#damper-multiplier-dev-pedal1).

Harness: `docs/development/diagnostics/dev-6f0c-sustain-player-live.py` (in-process, drives `schedule_event`, reads the online ring; `--only half_sweep`, `--preset`, `--pitch`). Extend its value list as below. Clean the stack before and after. Run on the preset the user is tuning and on `BaselinePreset1` (its old sweep is the before-picture). N >= 3 per point for any claim under 1 dB.

| # | Test | Method | Pass |
|---|---|---|---|
| 1 | Graded decay | note on, release at 700 ms with CC64 = v held, v = 0, 6, 16, 32, 48, 64, 80, 96, 110, 118, 127; p36, p60, p84: level at 1.0, 1.5, 2.5 s and decay rate dB/s | decay rate monotonic in v, no plateau beyond the dead zones, roughly even dB/s ratios per step (log law); old curve: everything below 127 sat within 7 dB of pedal up |
| 2 | Per-pitch normalisation | test 1 at every 6th pitch: pedal value at which the decay rate is the geometric mean of the two ends | same value within the register staging (+-10 steps after removing `register_spread`) |
| 3 | Register staging | fixed v = 60, 80, 100; chord p36 + p60 + p84 and single notes | bass rings longer than treble in the band; `register_spread` 0 removes the difference |
| 4 | 0 / 127 unchanged | old `.pyd` render vs new, offline `note_playback` + a file with 0 / 127 pedal, same preset (take the before-render BEFORE the rebuild) | buffer-vs-buffer at the run-to-run atomicAdd noise; `dev_parameters` slots 3 and 8 identical at v 0 and 127 via `returnParameters()` |
| 5 | Dead zones | v = 1-5 vs 0; v = 120-126 vs 127 | identical renders |
| 6 | Held key | key held, v sweep 0 to 127 | the held string's `dec2` slot unchanged by v; sympathetic strings change |
| 7 | Patch | at v = 60 read slot 8 over one string via `returnParameters()`; render with the patch offset on a node of partial n (position = k/n) | raised cosine at the expected point (settles the DMC row: fraction + index direction); partial n decays slower than with width 0 |
| 8 | Clicks | slow and fast sweeps 0-127-0 under a sustained chord; high-pass the ring above 8 kHz | no broadband transient at the steps. If any: ramp `sustain_value` per cycle (not included, no reason to expect one: damping changes no displacement or velocity) |
| 9 | parameterKernel timing | profiling build / `parameter_ms`, and the live cycle overrun count, while a scripted CC64 moves at 100 Hz for 30 s with 10 notes sounding; compare with pedal still | no new overruns; report mean and p99 ms per kernel. `SUSTAIN_MIN_CYCLE_GAP` raises if needed |
| 10 | Old presets | load 3 old presets, GET `pedal`, render | 200, defaults, tests 4-5 pass |
| 11 | Tunable | POST `pedal`, undo, save, reload | curve changes on sounding notes, undo restores, saved only when non-default |
| 12 | Controller, with the user | X12 to continuous + calibrate + save, via the panel; watch the monitor rows | CC64 moves 0-127 with the pedal, chip stable. Check the pedal reads with the internal pull-up (the dialog does not offer a no-pull-up option) |
| 13 | AMC-10 | right pedal live on the current `port_sustain` map | half pedal works; rest and full press hit the dead zones |

## Results (2026-10-31, offline renders unless noted; test binary Core b12ed7d)

Harnesses: `docs/development/diagnostics/dev-pedal1-offline.py`, `dev-pedal1-live.py`. Decay = dB/s fitted 0.35-1.0 s, release at 0.3 s.

| # | Result | Numbers |
|---|---|---|
| 1 | PASS | F15 thump_3 p60, v 0/16/32/48/64/80/96/110/127: 127.7/127.5/58/29/18.6/13.4/10.6/9.7/9.7 (old law 127/115/108/95/88/75/55/42/9.7). p36: 92/72/34/19/12/6.8/3.6/3.3/3.3. p84: 144/144/129/92/63/43/28/21/21. BaselinePreset1 p60: 49/49/49/52/38/22/9.4/6.2/6.2 (old 49 flat up to v 118, 6.2 at 127) |
| 2 | Marginal | geometric-mid pedal value after removing the spread, p24-p90: 47-49 bass, 33-41 middle, 52-55 top; +-11 around 44, target +-10. p96 has no damper (65 dB/s at any v) |
| 3 | PASS | dB/s p36/p60/p84 at v 60: 16.9/21/63 spread 0; spread 24 at v 80: 6.8/13.4/45 vs spread 0: 10.3/14.7/42, bass freer, treble tighter |
| 4 | PASS | 0 of 1 208 320 coefficients differ on 5 sequences, both presets; relative energy old vs new 2e-10 to 3e-8 (F15), at or below old vs old. Baseline up to 1.5e-5, old vs old 3.9e-4 |
| 5 | PASS | v 3, 5 vs 0 and 120, 124 vs 127: 1.7e-9 to 7.1e-9 |
| 6 | PASS | held p60 strings' dec2 6.25e-7 at v 0, 64, 127 |
| 7 | PASS | dec2 1.19e-6 along the string, 15/103/112/24e-6 at indices 10-13, hammer index 10: fraction and index direction confirmed. Partial 3 slope: whole -13, patch at hammer -5, patch on its node -21 dB/s (slopes are noisy here: mode beating, can be negative) |
| 8 | PASS | local HF crest (> 8 kHz, 2 ms over +-100 ms) still 3.8 dB, 100 Hz CC 3.9, 25 Hz 4.1, ends at 12 Hz 4.3; a same-value 100 Hz stream 4.4. No ramp needed |
| 9 | PASS | offline N=3: 4 s render 3.15 s still, 3.16 s at 100 Hz CC under 10 notes. Live ASIO, low volume: 709 CC at 72/s, 0 produce timeouts, no recovery, state ok, event latency 0.84 ms. `parameter_ms` per kernel not read (no profiling build) |
| 10 | PASS | Tuning18 and BaselinePreset1 load 200, config = defaults, engine_supported true |
| 11 | PASS (partly) | POST applied, 416 on a bad value, undo restored, absent from summary at defaults. Effect on sounding notes shown by test 3; save / reload not run (no preset writes) |
| 12 | Not run | needs the user's presses |
| 13 | Not run | needs the user's pedal; fixture replay of the AMC-10 capture passes in the unit tests |
