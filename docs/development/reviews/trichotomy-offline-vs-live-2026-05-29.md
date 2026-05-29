# Trichotomy bug — offline vs live decisive measurement (2026-05-29)

Belarus_8band_196modes-MFeq preset, pitches 55/56/57, NOTE_ON 200ms then NOTE_OFF, 2s capture.

## Method

- Current-dev backend at `67148fa`, freshly built `--heavy --both`, SDL3 driver.
- DAMPER_PROBE inserted at `Pianoid_synthesis.cu` confirms `damper_string[201..203] = 3.6e-05` live (matches preset value exactly).
- OFFLINE: `POST /get_chart_test {chartType:"note_playback"}` — synchronous offline render via `runOfflinePlayback`.
- LIVE: same backend, REST `/play` with explicit `command=144`/`128` to fire ON+OFF through `OnlinePlaybackEngine`. WAVs captured 2026-05-28 (`D:\tmp\currentdev-2026-05-28-p{55,56,57}.wav`).
- BASELINE 05-10: WAVs captured at commit `fdf3dd2` (`D:\tmp\baseline-2026-05-10-p{55,56,57}.wav`) via the same live REST path on the baseline backend.

## Results — RMS by window

| Pitch | Source       | RMS@0..200ms | RMS@400..500ms | RMS@900..1000ms | 400/pre ratio |
|-------|--------------|-------------:|---------------:|----------------:|--------------:|
| p55   | offline cur  |       0.3065 |        0.00106 |         0.00010 |      **0.003**|
| p55   | live cur     |       0.2422 |        0.08009 |         0.02454 |      0.331    |
| p55   | live baseline|       0.3867 |        0.14678 |         0.00019 |      0.380    |
| p56   | offline cur  |       0.3644 |        0.00071 |         0.00008 |      **0.002**|
| p56   | live cur     |       0.2377 |        0.12425 |         0.04590 |      0.523    |
| p56   | live baseline|       0.4514 |        0.10615 |         0.00014 |      0.235    |
| p57   | offline cur  |       0.3496 |        0.00026 |         0.00001 |      **0.001**|
| p57   | live cur     |       0.3665 |        0.14528 |         0.02182 |      0.396    |
| p57   | live baseline|       0.4453 |        0.11631 |         0.00005 |      0.261    |

## Findings

1. **Offline-current-dev damps brilliantly** — 400ms-post-noteoff RMS drops to ~0.1% of pre, 900ms to ~0.03%. Same kernel, same preset, same `damper_string=3.6e-05`. This proves the kernel CAN damp these strings on this backend.

2. **Live-current-dev damps poorly** — at 900ms, RMS is 122-459x worse than baseline. P56 is the worst (0.046, ~459x). P55 and P57 less bad but still broken (~120x and ~218x).

3. **Live-baseline-05-10 damps correctly** — 900ms RMS is ~0.0001, same order as offline-current-dev.

4. **The "trichotomy" perception** (P55 ok, P56 worst, P57 click) reflects relative magnitudes — all three pitches are damaged on live current dev, but P56 is the most damaged. P55 is least damaged, hence "OK to the ear". P57 has additional click character that may relate to the disp_decay step at the 56→57 boundary (3.158e-14 → 3.196e-14) interacting with the broken damping.

5. **The regression is in the LIVE engine wrapper between `fdf3dd2` and `67148fa`** — specifically code that runs in `OnlinePlaybackEngine::processEventsAtCycle` / SDL3 callback / per-cycle parameter sync. The kernel and the offline wrapper are NOT regressed.

## Next-step candidates

- Diff `OnlinePlaybackEngine.cu`, `SDL3AudioDriver.cu`, `EventDispatcher.cu` between baseline and current dev specifically for code that touches per-cycle parameter sync or `loadParameterToPianoid` invocations.
- Look for additions of new per-cycle code that may RESET dec_open or zero shift_b between cycles.
- Check if `processEventsAtCycle` correctly drives `runSynthesisKernel` per cycle, or if there's a bypass path that skips parameterKernel.
- Suspect commits: the `dev-cbd5` Pianoid.cu split, anything affecting `EventDispatcher::dispatchBatch`, anything in the SDL3 audio thread.

## Artifacts

- WAVs: `D:\tmp\offline-current-dev-p{55,56,57}.wav` (fresh) plus the pre-existing `currentdev-2026-05-28-*.wav` and `baseline-2026-05-10-*.wav`.
- Measurement scripts: `D:\tmp\trichotomy-offline-measure.py`, `D:\tmp\compare-wavs.py`.
- Build/backend logs: `D:\tmp\damper-probe-build.log`, `D:\tmp\damper-probe-backend.log`.
- Probe still in source at `pianoid_cuda/Pianoid_synthesis.cu` lines 203-210, `pianoid_cuda/Pianoid_excitation.cu` line 36. NOT committed.
