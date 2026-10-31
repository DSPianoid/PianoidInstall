# Half pedal: post-rebuild test plan (dev-pedal1)

Nothing below has run: it needs the rebuilt `pianoid_cuda`. Design: [MIDI_SYSTEM → Half pedal](../modules/pianoid-middleware/MIDI_SYSTEM.md#half-pedal-dev-pedal1), law: [SYNTHESIS_ENGINE](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#damper-multiplier-dev-pedal1).

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
